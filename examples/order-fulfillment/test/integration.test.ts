import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { generateEncryptionKey } from 'good-webhooks'
import type { Delivery, DeliveryDetail, Endpoint } from 'good-webhooks'
import { defaultDatabaseUrl, readConfig } from '../src/config.ts'
import { createRuntime } from '../src/runtime.ts'
import { migrate } from '../scripts/migrate.ts'

type State = {
  orders: { id: string; eventId: string; customer: string; totalCents: number }[]
  endpoint: Endpoint | null
  deliveries: Delivery[]
  shipments: { eventId: string; orderId: string; customer: string }[]
  receiver: { mode: string; accepted: number; duplicates: number }
  worker: { running: boolean }
}
async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}
async function until<T>(
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  message: string,
  timeoutMs = 20000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await read()
      if (accepts(value)) return value
      last = value
    } catch (error) {
      last = error
    }
    await delay(100)
  }
  throw new Error(`${message}. Last result: ${JSON.stringify(last)}`)
}

test(
  'real HTTP, PostgreSQL, independent worker, signed receiver, and durable recovery',
  { timeout: 90000 },
  async (context) => {
    // This suite only creates and later removes its own unpredictable schema.
    // It never truncates or resets a database, including TEST_DATABASE_URL.
    const env = {
      ...process.env,
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl,
      WEBHOOK_ENCRYPTION_KEY: generateEncryptionKey(),
      APP_SCHEMA: `northstar_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      APP_PORT: String(await freePort()),
      RECEIVER_PORT: String(await freePort()),
    }
    const config = readConfig(env)
    const runtime = createRuntime(config)
    const children = new Set<ChildProcess>()
    let logs = ''
    function start(entry: string) {
      const child = spawn(process.execPath, [`src/${entry}.ts`], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      children.add(child)
      child.stdout!.on('data', (chunk) => {
        logs += `${entry}: ${chunk}`
      })
      child.stderr!.on('data', (chunk) => {
        logs += `${entry}: ${chunk}`
      })
      return child
    }
    async function stop(child: ChildProcess) {
      if (child.exitCode !== null || child.signalCode !== null) {
        children.delete(child)
        return
      }
      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        child.once('exit', (code, signal) => resolve({ code, signal })),
      )
      child.kill('SIGTERM')
      const deadline = setTimeout(() => child.kill('SIGKILL'), 15000)
      try {
        const result = await exit
        assert.equal(
          result.code,
          0,
          `Process should stop cleanly: ${JSON.stringify(result)}\n${logs}`,
        )
      } finally {
        clearTimeout(deadline)
        children.delete(child)
      }
    }
    const base = `http://127.0.0.1:${config.appPort}`
    async function request(
      path: string,
      body?: unknown,
      expected = 200,
      headers: Record<string, string> = {},
    ) {
      const response = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const json = await response.json()
      assert.equal(response.status, expected, `${path}: ${JSON.stringify(json)}`)
      return json
    }
    const state = async () => request('/api/state') as Promise<State>
    const order = (customer: string, extras: Record<string, unknown> = {}) => ({
      customer,
      sku: 'TRAIL-PACK',
      quantity: 2,
      idempotencyKey: randomUUID(),
      ...extras,
    })
    try {
      await migrate(config)
      await migrate(config) // Migration ledger makes explicit setup repeatable.
      let app = start('server')
      let receiver = start('receiver')
      await until(state, () => true, 'shop did not start')
      await until(
        () => fetch(`http://127.0.0.1:${config.receiverPort}/health`),
        (response) => response.ok,
        'warehouse did not start',
      )

      await context.test('local admin boundary and validation reject invalid input', async () => {
        await request('/api/connect', {}, 403, { origin: 'https://foreign.example' })
        const foreignHostStatus = await new Promise<number>((resolve, reject) => {
          const outgoing = httpRequest(
            `${base}/api/connect`,
            {
              method: 'POST',
              headers: { host: 'foreign.example', 'content-type': 'application/json' },
            },
            (response) => {
              response.resume()
              resolve(response.statusCode!)
            },
          )
          outgoing.on('error', reject)
          outgoing.end('{}')
        })
        assert.equal(foreignHostStatus, 403)
        const wrongContentType = await fetch(`${base}/api/connect`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: '{}',
        })
        assert.equal(wrongContentType.status, 415)
        await request('/api/orders', order('Customer', { quantity: 0 }), 400)
        await request('/api/orders', order('Customer', { sku: 'invented' }), 400)
        await request('/api/orders', order('Customer', { totalCents: 1 }), 400)
      })

      let endpointId = ''
      await context.test(
        'concurrent connect creates one endpoint and keeps secrets off HTTP',
        async () => {
          const connected = await Promise.all([
            request('/api/connect', {}),
            request('/api/connect', {}),
          ])
          endpointId = connected[0].endpoint.id
          assert.equal(connected[1].endpoint.id, endpointId)
          assert.equal((await runtime.webhooks.endpoints.list()).length, 1)
          assert(!JSON.stringify(await state()).includes('secret'))
          const unsigned = await fetch(`http://127.0.0.1:${config.receiverPort}/webhooks`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          assert.equal(unsigned.status, 400)
          const forged = await fetch(`http://127.0.0.1:${config.receiverPort}/webhooks`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'webhook-id': randomUUID(),
              'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
              'webhook-signature': 'v1,aW52YWxpZA==',
            },
            body: '{}',
          })
          assert.equal(forged.status, 400)
        },
      )

      let firstEventId = ''
      let firstDeliveryId = ''
      await context.test(
        'publication is durable without a worker and business idempotency survives concurrency',
        async () => {
          const input = order('Avery Stone')
          const results = await Promise.all([
            request('/api/orders', input, 201),
            request('/api/orders', input, 201),
          ])
          assert.equal(results[0].order.id, results[1].order.id)
          assert.equal(results[0].order.totalCents, 15800)
          assert.deepEqual(results.map((result) => result.publication.duplicate).sort(), [
            false,
            true,
          ])
          firstEventId = results[0].publication.eventId
          await request('/api/orders', { ...input, quantity: 3 }, 409)
          const snapshot = await state()
          assert.equal(snapshot.orders.length, 1)
          assert.equal(snapshot.shipments.length, 0)
          assert.equal(snapshot.deliveries.length, 1)
          assert.equal(snapshot.deliveries[0].status, 'pending')
          firstDeliveryId = snapshot.deliveries[0].id
          assert.equal(snapshot.worker.running, false)
          await request(`/api/deliveries/${firstDeliveryId}/replay`, {}, 409)
        },
      )

      await context.test(
        'business rollback also removes publication and releases its idempotency key',
        async () => {
          const input = order('Rollback Customer')
          const rolledBack = await request('/api/orders', { ...input, rollback: true }, 409)
          assert.equal(rolledBack.code, 'DEMO_ROLLBACK')
          const snapshot = await state()
          assert.equal(snapshot.orders.length, 1)
          assert.equal(snapshot.deliveries.length, 1)
          const retry = await request('/api/orders', input, 201)
          assert.equal(retry.publication.duplicate, false)
          assert.equal(retry.publication.deliveryCount, 1)
        },
      )

      await context.test('app restart reuses endpoint and receiver signing material', async () => {
        await stop(app)
        app = start('server')
        await until(state, (value) => value.orders.length === 2, 'orders did not persist')
        assert.equal((await request('/api/connect', {})).endpoint.id, endpointId)
      })

      let worker = start('worker')
      await context.test(
        'separate continuous worker delivers verified payload and records actual attempts',
        async () => {
          const delivered = await until(
            state,
            (value) =>
              value.shipments.length === 2 &&
              value.deliveries.every((delivery) => delivery.status === 'succeeded'),
            'worker did not deliver queued orders',
          )
          assert.equal(delivered.worker.running, true)
          const detail = (await request(`/api/deliveries/${firstDeliveryId}`)) as DeliveryDetail
          assert.equal(detail.attemptCount, 1)
          assert.equal(detail.attempts[0].responseStatus, 200)
          assert(delivered.shipments.some((shipment) => shipment.eventId === firstEventId))
        },
      )

      await context.test(
        '503 retries exhaust policy, recovery replays the retained event',
        async () => {
          await request('/api/receiver', { mode: 'reject' })
          const created = await request('/api/orders', order('Morgan Reed'), 201)
          const failed = await until(
            state,
            (value) =>
              value.deliveries.some(
                (delivery) =>
                  delivery.eventId === created.publication.eventId && delivery.status === 'failed',
              ),
            '503 delivery did not exhaust retries',
          )
          const original = failed.deliveries.find(
            (delivery) => delivery.eventId === created.publication.eventId,
          )!
          const detail = (await request(`/api/deliveries/${original.id}`)) as DeliveryDetail
          assert.equal(detail.attemptCount, 4)
          assert.deepEqual(
            detail.attempts.map((attempt) => attempt.responseStatus),
            [503, 503, 503, 503],
          )
          assert.equal(failed.shipments.length, 2)
          await request('/api/receiver', { mode: 'healthy' })
          const replay = await request(`/api/deliveries/${original.id}/replay`, {}, 201)
          assert.notEqual(replay.id, original.id)
          assert.equal(replay.eventId, original.eventId)
          assert.equal(replay.replayOf, original.id)
          await until(
            state,
            (value) =>
              value.shipments.length === 3 &&
              value.deliveries.some(
                (delivery) => delivery.id === replay.id && delivery.status === 'succeeded',
              ),
            'replay did not deliver',
          )
          await request(`/api/deliveries/${replay.id}/replay`, {}, 409)
        },
      )

      await context.test(
        'receiver restart preserves durable deduplication when a success is replayed',
        async () => {
          await stop(receiver)
          receiver = start('receiver')
          await until(
            () => fetch(`http://127.0.0.1:${config.receiverPort}/health`),
            (response) => response.ok,
            'restarted warehouse did not start',
          )
          const replay = await request(`/api/deliveries/${firstDeliveryId}/replay`, {}, 201)
          const duplicate = await until(
            state,
            (value) =>
              value.deliveries.some(
                (delivery) => delivery.id === replay.id && delivery.status === 'succeeded',
              ),
            'successful replay did not finish',
          )
          assert.equal(duplicate.shipments.length, 3)
          assert.equal(duplicate.receiver.duplicates, 1)
          assert.equal(duplicate.receiver.accepted, 3)
        },
      )

      await context.test('pause retains subscriptions and queues work until resume', async () => {
        await request('/api/endpoint', { status: 'paused' })
        const placed = await request('/api/orders', order('Jamie Park'), 201)
        assert.equal(placed.publication.deliveryCount, 1)
        await delay(700)
        const held = (await state()).deliveries.find(
          (delivery) => delivery.eventId === placed.publication.eventId,
        )!
        assert.equal(held.status, 'pending')
        assert.equal(held.attemptCount, 0)
        await request('/api/endpoint', { status: 'active' })
        await until(
          state,
          (value) => value.shipments.length === 4,
          'paused delivery did not resume',
          35000,
        )
      })

      await context.test(
        'worker clean shutdown stops processing; restart drains durable queued work',
        async () => {
          await stop(worker)
          assert.equal((await state()).worker.running, false)
          const placed = await request('/api/orders', order('Rowan Miles'), 201)
          await delay(400)
          const queued = (await state()).deliveries.find(
            (delivery) => delivery.eventId === placed.publication.eventId,
          )!
          assert.equal(queued.status, 'pending')
          worker = start('worker')
          await until(
            state,
            (value) => value.shipments.length === 5,
            'worker restart did not drain queue',
          )
        },
      )
      await context.test(
        'new orders remain first in delivery history beyond nine deliveries',
        async () => {
          let newestEventId = ''
          for (let index = 0; index < 12; index++) {
            const placed = await request('/api/orders', order(`History customer ${index}`), 201)
            newestEventId = placed.publication.eventId
          }
          const history = (await state()).deliveries
          assert.equal(history[0].eventId, newestEventId)
          for (let index = 1; index < history.length; index++) {
            assert(BigInt(history[index - 1].id) > BigInt(history[index].id))
          }
        },
      )
      await stop(worker)
      await stop(receiver)
      await stop(app)
    } catch (error) {
      console.error(logs)
      throw error
    } finally {
      for (const child of children) {
        try {
          await stop(child)
        } catch {
          child.kill('SIGKILL')
        }
      }
      // Only this suite's freshly generated schema is removed.
      await runtime.pool.query(`DROP SCHEMA IF EXISTS "${config.schema}" CASCADE`)
      await runtime.pool.end()
    }
  },
)
