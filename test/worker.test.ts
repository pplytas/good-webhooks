import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encryptSecret, generateSecret, signWebhook, verifyWebhook } from '../src/crypto.js'
import { createStore } from '../src/store.js'
import { sendWebhook } from '../src/transport.js'
import { createWorker } from '../src/worker.js'
import { createWorkerStore } from '../src/worker-store.js'
import type { ClaimedDelivery, Database } from '../src/types.js'
import { closeDatabase, pool, resetDatabase, testConfig } from './db.js'

const servers: Server[] = []
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
async function receiver(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Receiver did not bind')
  return `http://127.0.0.1:${address.port}/webhook`
}
async function fixture(url: string, count = 1, maxInFlight = 2) {
  const endpointId = randomUUID()
  const secret = generateSecret()
  await pool.query(
    `INSERT INTO webhooks.endpoints(id,tenant_id,url,event_types,secret,max_in_flight)
    VALUES($1,'tenant-a',$2,ARRAY['test.sent'],$3,$4)`,
    [endpointId, url, encryptSecret(secret, testConfig().encryptionKey), maxInFlight],
  )
  const deliveries: { id: string; eventId: string; body: string }[] = []
  for (let n = 0; n < count; n++) {
    const eventId = randomUUID()
    const body = JSON.stringify({ id: eventId, type: 'test.sent', data: { n } })
    await pool.query(
      `INSERT INTO webhooks.events(id,tenant_id,type,body,fingerprint)
      VALUES($1,'tenant-a','test.sent',$2,'fixture')`,
      [eventId, body],
    )
    const result = await pool.query<{ id: string }>(
      `INSERT INTO webhooks.deliveries(tenant_id,endpoint_id,event_id)
      VALUES('tenant-a',$1,$2) RETURNING id::text`,
      [endpointId, eventId],
    )
    deliveries.push({ id: result.rows[0]!.id, eventId, body })
  }
  return { endpointId, secret, deliveries }
}
async function due() {
  await pool.query(
    "UPDATE webhooks.deliveries SET next_attempt_at=now()-interval '1 second' WHERE status='pending'",
  )
}
async function expire(claim: ClaimedDelivery) {
  await pool.query(
    "UPDATE webhooks.deliveries SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [claim.id],
  )
}
async function state(id: string) {
  const delivery = (await pool.query('SELECT * FROM webhooks.deliveries WHERE id=$1', [id]))
    .rows[0]!
  const attempts = (
    await pool.query('SELECT * FROM webhooks.attempts WHERE delivery_id=$1 ORDER BY number', [id])
  ).rows
  return { delivery, attempts }
}

beforeEach(resetDatabase)
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
          server.closeAllConnections()
        }),
    ),
  )
})
afterAll(closeDatabase)

describe('worker delivery durability', () => {
  it('persists the started attempt before HTTP and signs exactly the persisted body', async () => {
    const received = deferred<{ body: string; headers: IncomingMessage['headers'] }>()
    const finish = deferred()
    const url = await receiver((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        body += chunk
      })
      request.on('end', () => {
        received.resolve({ body, headers: request.headers })
        void finish.promise.then(() => response.end('accepted'))
      })
    })
    const {
      deliveries: [delivery],
      secret,
    } = await fixture(url)
    const pending = createWorker(testConfig()).tick()
    const request = await received.promise
    const started = await state(delivery!.id)
    expect(started.delivery.status).toBe('in_flight')
    expect(started.delivery.attempt_count).toBe(1)
    expect(started.attempts).toMatchObject([{ number: 1, outcome: 'started', finished_at: null }])
    expect(request.body).toBe(delivery!.body)
    verifyWebhook({
      body: request.body,
      headers: request.headers as Record<string, string>,
      secret,
    })
    expect(request.headers['webhook-id']).toBe(delivery!.eventId)
    finish.resolve()
    expect(await pending).toEqual({ claimed: 1, succeeded: 1, retried: 0, failed: 0, stale: 0 })
    expect((await state(delivery!.id)).attempts).toMatchObject([
      { outcome: 'succeeded', response_body: 'accepted', response_status: 200 },
    ])
  })

  it('enforces an endpoint cap across competing workers and rejects overlapping ticks', async () => {
    let active = 0
    let peak = 0
    const full = deferred()
    const finish = deferred()
    const url = await receiver((_request, response) => {
      active++
      peak = Math.max(peak, active)
      if (active === 2) full.resolve()
      void finish.promise.then(() => {
        active--
        response.end('ok')
      })
    })
    await fixture(url, 6, 2)
    const worker = createWorker(testConfig({ concurrency: 5 }))
    const a = worker.tick()
    const b = createWorker(testConfig({ concurrency: 5 })).tick()
    await full.promise
    await expect(worker.tick()).rejects.toMatchObject({ code: 'INVALID_STATE' })
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM webhooks.deliveries WHERE status='in_flight'",
        )
      ).rows[0].count,
    ).toBe(2)
    finish.resolve()
    const results = await Promise.all([a, b])
    expect(results.reduce((sum, result) => sum + result.claimed, 0)).toBe(2)
    expect(peak).toBe(2)
    expect((await worker.tick()).claimed).toBe(2)
  })

  it('prioritizes the oldest due endpoint instead of its UUID', async () => {
    const url = await receiver((_request, response) => response.end())
    const first = await fixture(url)
    const second = await fixture(url)
    const [lower, higher] = [first, second].sort((a, b) => a.endpointId.localeCompare(b.endpointId))
    await pool.query(
      "UPDATE webhooks.deliveries SET next_attempt_at=now()-interval '1 hour' WHERE endpoint_id=$1",
      [higher!.endpointId],
    )
    const worker = createWorker(testConfig({ concurrency: 1 }))
    expect((await worker.tick()).succeeded).toBe(1)
    expect((await state(higher!.deliveries[0]!.id)).delivery.status).toBe('succeeded')
    expect((await state(lower!.deliveries[0]!.id)).delivery.status).toBe('pending')
  })

  it('preserves due priority after locking UUID order when one endpoint could fill the batch', async () => {
    const url = await receiver((_request, response) => response.end())
    const first = await fixture(url, 3, 2)
    const second = await fixture(url, 3, 2)
    const [lower, higher] = [first, second].sort((a, b) => a.endpointId.localeCompare(b.endpointId))
    await pool.query(
      "UPDATE webhooks.deliveries SET next_attempt_at=now()-interval '1 hour' WHERE id=$1",
      [higher!.deliveries[0]!.id],
    )
    const worker = createWorker(testConfig({ concurrency: 2 }))
    expect((await worker.tick()).succeeded).toBe(2)
    expect((await state(higher!.deliveries[0]!.id)).delivery.status).toBe('succeeded')
    expect((await state(lower!.deliveries[0]!.id)).delivery.status).toBe('pending')
  })

  it('recovers a crash after receiver acceptance, delivering the same event id again', async () => {
    const ids: string[] = []
    const url = await receiver((request, response) => {
      ids.push(String(request.headers['webhook-id']))
      response.end('accepted')
    })
    const {
      deliveries: [delivery],
    } = await fixture(url)
    const config = testConfig()
    const storage = createWorkerStore(config)
    const [claim] = await storage.claim()
    const accepted = await sendWebhook({
      url,
      body: claim!.body,
      headers: signWebhook({
        id: claim!.eventId,
        timestamp: Math.floor(Date.now() / 1000),
        body: claim!.body,
        secrets: [claim!.secret],
      }),
      timeoutMs: 1000,
      maxResponseBytes: 100,
      allowLocalhost: true,
    })
    expect(accepted.status).toBe(200)
    // Simulate death before recording the accepted response.
    await expire(claim!)
    await storage.recoverExpired()
    expect((await state(delivery!.id)).attempts[0].outcome).toBe('abandoned')
    await due()
    expect((await createWorker(config).tick()).succeeded).toBe(1)
    expect(ids).toEqual([delivery!.eventId, delivery!.eventId])
    expect((await state(delivery!.id)).attempts.map((a) => a.outcome)).toEqual([
      'abandoned',
      'succeeded',
    ])
  })

  it('fences an expired token before and after a replacement claim', async () => {
    await fixture('http://127.0.0.1:12345')
    const storage = createWorkerStore(testConfig())
    const [old] = await storage.claim()
    await expire(old!)
    const success = { status: 200, responseBody: 'ok', error: null, retryable: false }
    expect(await storage.complete(old!, success)).toBe('stale')
    await storage.recoverExpired()
    await due()
    const [fresh] = await storage.claim()
    expect(fresh!.token).not.toBe(old!.token)
    expect(await storage.complete(old!, success)).toBe('stale')
    expect(await storage.complete(fresh!, success)).toBe('succeeded')
    expect((await state(old!.id)).attempts.map((a) => a.outcome)).toEqual([
      'abandoned',
      'succeeded',
    ])
  })

  it('exhausts retries after the configured total attempts and bounds jitter', async () => {
    const url = await receiver((_request, response) => {
      response.statusCode = 503
      response.end('unavailable')
    })
    const {
      deliveries: [delivery],
    } = await fixture(url)
    const worker = createWorker(testConfig({ retryDelaysMs: [1000, 2000] }))
    for (const [index, delay] of [1000, 2000].entries()) {
      const before = Date.now()
      expect((await worker.tick()).retried).toBe(1)
      const current = await state(delivery!.id)
      expect(current.delivery.attempt_count).toBe(index + 1)
      const scheduled = current.delivery.next_attempt_at.getTime()
      expect(scheduled).toBeGreaterThanOrEqual(before + delay)
      expect(scheduled).toBeLessThanOrEqual(Date.now() + delay * 1.2)
      await due()
    }
    expect((await worker.tick()).failed).toBe(1)
    expect((await worker.tick()).claimed).toBe(0)
    const current = await state(delivery!.id)
    expect(current.delivery.status).toBe('failed')
    expect(current.attempts.map((a) => a.outcome)).toEqual(['retry', 'retry', 'failed'])
    expect(current.delivery.last_status).toBe(503)
  })

  it.each([408, 425, 429, 500, 503])('retries HTTP %i', async (status) => {
    const url = await receiver((_request, response) => {
      response.statusCode = status
      response.end()
    })
    await fixture(url)
    expect((await createWorker(testConfig()).tick()).retried).toBe(1)
  })

  it.each([301, 400, 401, 404, 422, 600])('fails permanently on HTTP %i', async (status) => {
    const url = await receiver((_request, response) => {
      response.statusCode = status
      response.end()
    })
    await fixture(url)
    expect((await createWorker(testConfig()).tick()).failed).toBe(1)
  })

  it('fails unsafe destinations permanently without opening a socket', async () => {
    let requests = 0
    const url = await receiver((_request, response) => {
      requests++
      response.end()
    })
    const {
      deliveries: [delivery],
    } = await fixture(url)
    expect((await createWorker(testConfig({ allowLocalhost: false })).tick()).failed).toBe(1)
    expect(requests).toBe(0)
    expect((await state(delivery!.id)).delivery.last_error).toBe('unsafe_url')
  })

  it('retries a timed out request and bounds persisted diagnostics', async () => {
    const url = await receiver(() => undefined)
    const {
      deliveries: [delivery],
    } = await fixture(url)
    expect((await createWorker(testConfig({ timeoutMs: 50 })).tick()).retried).toBe(1)
    expect((await state(delivery!.id)).attempts[0].error).toBe('timeout')
  })

  it('retries when a partial HTTP200 response stalls before completion', async () => {
    const url = await receiver((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('partial')
    })
    const {
      deliveries: [delivery],
    } = await fixture(url)
    expect(await createWorker(testConfig({ timeoutMs: 50 })).tick()).toMatchObject({
      claimed: 1,
      succeeded: 0,
      retried: 1,
      failed: 0,
    })
    const current = await state(delivery!.id)
    expect(current.delivery).toMatchObject({
      status: 'pending',
      last_status: 200,
      last_error: 'timeout',
    })
    expect(current.attempts[0]).toMatchObject({
      outcome: 'retry',
      response_status: 200,
      response_body: 'partial',
      error: 'timeout',
    })
  })

  it('retries when a partial HTTP200 response connection resets', async () => {
    const url = await receiver((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('partial')
      setTimeout(() => response.destroy(), 20)
    })
    const {
      deliveries: [delivery],
    } = await fixture(url)
    expect(await createWorker(testConfig()).tick()).toMatchObject({
      claimed: 1,
      succeeded: 0,
      retried: 1,
      failed: 0,
    })
    const current = await state(delivery!.id)
    expect(current.delivery).toMatchObject({
      status: 'pending',
      last_status: 200,
      last_error: 'network_error',
    })
    expect(current.attempts[0]).toMatchObject({
      outcome: 'retry',
      response_status: 200,
      response_body: 'partial',
      error: 'network_error',
    })
  })

  it('refreshes every lease after a slow multirow claim transaction', async () => {
    await fixture('http://127.0.0.1:12345', 3, 3)
    let delayedInserts = 0
    const database: Database = {
      query: pool.query.bind(pool),
      async connect() {
        const client = await pool.connect()
        return {
          release: () => client.release(),
          async query<R extends Record<string, unknown>>(text: string, values?: unknown[]) {
            const result = await client.query<R>(text, values)
            if (text.startsWith('INSERT INTO webhooks.attempts')) {
              delayedInserts++
              await new Promise((resolve) => setTimeout(resolve, 150))
            }
            return result
          },
        }
      },
    }
    const storage = createWorkerStore(
      testConfig({ database, concurrency: 3, timeoutMs: 40, leaseMs: 100 }),
    )
    const claims = await storage.claim()
    expect(delayedInserts).toBe(3)
    expect(claims).toHaveLength(3)
    const leases = await pool.query<{ live: boolean; lease_expires_at: Date }>(
      'SELECT lease_expires_at>clock_timestamp() AS live,lease_expires_at FROM webhooks.deliveries',
    )
    expect(leases.rows.every((row) => row.live)).toBe(true)
    expect(new Set(leases.rows.map((row) => row.lease_expires_at.getTime())).size).toBe(1)
    const outcomes = await Promise.all(
      claims.map((claim) =>
        storage.complete(claim, {
          status: 200,
          responseBody: 'ok',
          error: null,
          retryable: false,
        }),
      ),
    )
    expect(outcomes).toEqual(['succeeded', 'succeeded', 'succeeded'])
  })

  it('expires old pending and abandoned deliveries without additional requests', async () => {
    let requests = 0
    const url = await receiver((_request, response) => {
      requests++
      response.end()
    })
    const { deliveries } = await fixture(url, 2)
    const storage = createWorkerStore(testConfig({ concurrency: 1 }))
    const [claim] = await storage.claim()
    await pool.query("UPDATE webhooks.deliveries SET created_at=now()-interval '2 minutes'")
    await expire(claim!)
    expect((await createWorker(testConfig()).tick()).claimed).toBe(0)
    expect(requests).toBe(0)
    for (const delivery of deliveries)
      expect((await state(delivery.id)).delivery.status).toBe('failed')
    expect((await state(claim!.id)).attempts[0].outcome).toBe('abandoned')
  })

  it('pauses future claims while allowing an existing attempt to complete', async () => {
    const received = deferred()
    const finish = deferred()
    const url = await receiver((_request, response) => {
      received.resolve()
      void finish.promise.then(() => response.end())
    })
    const { endpointId } = await fixture(url, 2, 1)
    const worker = createWorker(testConfig())
    const first = worker.tick()
    await received.promise
    await createStore(testConfig()).pauseEndpoint('tenant-a', endpointId)
    finish.resolve()
    expect((await first).succeeded).toBe(1)
    expect((await worker.tick()).claimed).toBe(0)
    await createStore(testConfig()).resumeEndpoint('tenant-a', endpointId)
    expect((await worker.tick()).succeeded).toBe(1)
  })

  it('fences completion after endpoint deletion and cancels queued work', async () => {
    const received = deferred()
    const finish = deferred()
    const url = await receiver((_request, response) => {
      received.resolve()
      void finish.promise.then(() => response.end())
    })
    const { endpointId, deliveries } = await fixture(url, 2, 1)
    const worker = createWorker(testConfig())
    const first = worker.tick()
    await received.promise
    await createStore(testConfig()).removeEndpoint('tenant-a', endpointId)
    finish.resolve()
    expect((await first).stale).toBe(1)
    expect((await worker.tick()).claimed).toBe(0)
    for (const delivery of deliveries)
      expect((await state(delivery.id)).delivery.status).toBe('cancelled')
    expect((await state(deliveries[0]!.id)).attempts[0].outcome).toBe('abandoned')
  })

  it('does not consume an attempt when encryption configuration is wrong', async () => {
    const {
      deliveries: [delivery],
    } = await fixture('http://127.0.0.1:12345')
    await expect(
      createWorker(testConfig({ encryptionKey: new Uint8Array(32).fill(2) })).tick(),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    const current = await state(delivery!.id)
    expect(current.delivery).toMatchObject({
      status: 'pending',
      attempt_count: 0,
      claim_token: null,
    })
    expect(current.attempts).toEqual([])
  })

  it('rolls back the entire batch if any endpoint secret cannot be decrypted', async () => {
    const first = await fixture('http://127.0.0.1:12345')
    const second = await fixture('http://127.0.0.1:12345')
    const later = [first.endpointId, second.endpointId].sort()[1]!
    await pool.query('UPDATE webhooks.endpoints SET secret=$2 WHERE id=$1', [later, 'corrupted'])
    await expect(createWorker(testConfig()).tick()).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    })
    expect((await pool.query('SELECT status,attempt_count FROM webhooks.deliveries')).rows).toEqual(
      [
        { status: 'pending', attempt_count: 0 },
        { status: 'pending', attempt_count: 0 },
      ],
    )
    expect((await pool.query('SELECT * FROM webhooks.attempts')).rows).toEqual([])
  })

  it('fails an abandoned claim when no retry attempts remain', async () => {
    const {
      deliveries: [delivery],
    } = await fixture('http://127.0.0.1:12345')
    const storage = createWorkerStore(testConfig({ retryDelaysMs: [] }))
    const [claim] = await storage.claim()
    await expire(claim!)
    await storage.recoverExpired()
    expect((await state(delivery!.id)).delivery).toMatchObject({
      status: 'failed',
      attempt_count: 1,
      claim_token: null,
    })
    expect((await state(delivery!.id)).attempts[0].outcome).toBe('abandoned')
    expect(await storage.claim()).toEqual([])
  })

  it('includes an old signing secret only during its grace period', async () => {
    const previous = generateSecret()
    const signatures: string[] = []
    const url = await receiver((request, response) => {
      signatures.push(String(request.headers['webhook-signature']))
      response.end()
    })
    const { endpointId } = await fixture(url, 2, 1)
    await pool.query(
      `UPDATE webhooks.endpoints SET previous_secret=$2,
      previous_secret_expires_at=now()+interval '1 hour' WHERE id=$1`,
      [endpointId, encryptSecret(previous, testConfig().encryptionKey)],
    )
    const worker = createWorker(testConfig())
    await worker.tick()
    await pool.query(
      "UPDATE webhooks.endpoints SET previous_secret_expires_at=now()-interval '1 second' WHERE id=$1",
      [endpointId],
    )
    await worker.tick()
    expect(signatures.map((signature) => signature.split(' ').length)).toEqual([2, 1])
  })

  it('gives a replay fresh retry age while retention stays tied to its event', async () => {
    const url = await receiver((_request, response) => response.end())
    const {
      deliveries: [delivery],
    } = await fixture(url)
    await pool.query("UPDATE webhooks.events SET created_at=now()-interval '2 minutes'")
    await pool.query(
      "UPDATE webhooks.deliveries SET status='failed', created_at=now()-interval '2 minutes'",
    )
    const replay = await createStore(testConfig()).replay('tenant-a', delivery!.id)
    expect((await createWorker(testConfig()).tick()).succeeded).toBe(1)
    expect((await state(replay.id)).delivery.status).toBe('succeeded')
    expect(await createWorker(testConfig({ retentionMs: 60_000 })).prune()).toBe(1)
    expect((await pool.query('SELECT * FROM webhooks.deliveries')).rows).toEqual([])
  })

  it('prunes expired events in bounded batches and defers active claims', async () => {
    const {
      deliveries: [delivery],
    } = await fixture('http://127.0.0.1:12345')
    await createWorkerStore(testConfig()).claim()
    await pool.query("UPDATE webhooks.events SET created_at=now()-interval '2 days'")
    await pool.query(`INSERT INTO webhooks.events(id,tenant_id,type,body,fingerprint,created_at)
      SELECT gen_random_uuid(),'tenant-a','test.sent','{}','fixture',now()-interval '2 days' FROM generate_series(1,101)`)
    const worker = createWorker(testConfig())
    const first = await worker.prune()
    expect(first).toBeGreaterThanOrEqual(99)
    expect(first).toBeLessThanOrEqual(100)
    expect(await worker.prune()).toBe(101 - first)
    expect((await pool.query('SELECT id FROM webhooks.events')).rows).toEqual([
      { id: delivery!.eventId },
    ])
  })
})

describe('explicit worker lifecycle', () => {
  it('does not connect or start polling on construction or with an aborted signal', async () => {
    const database = { query: vi.fn(), connect: vi.fn() }
    const worker = createWorker(testConfig({ database }))
    const controller = new AbortController()
    controller.abort()
    expect(await worker.tick({ signal: controller.signal })).toMatchObject({ claimed: 0 })
    await worker.run({ signal: controller.signal })
    expect(database.query).not.toHaveBeenCalled()
    expect(database.connect).not.toHaveBeenCalled()
  })

  it('aborts an active send, persists uncertainty, and leaves the pool usable', async () => {
    const received = deferred()
    const url = await receiver(() => received.resolve())
    const {
      deliveries: [delivery],
    } = await fixture(url)
    const controller = new AbortController()
    const worker = createWorker(testConfig())
    const running = worker.run({ signal: controller.signal })
    await received.promise
    await expect(worker.tick()).rejects.toMatchObject({ code: 'INVALID_STATE' })
    await expect(worker.run({ signal: controller.signal })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    controller.abort()
    await running
    expect((await state(delivery!.id)).delivery.status).toBe('pending')
    expect((await state(delivery!.id)).attempts[0].outcome).toBe('abandoned')
    expect((await pool.query('SELECT 1 AS alive')).rows[0].alive).toBe(1)
  })

  it('reports operational errors through the callback without consuming attempts', async () => {
    const {
      deliveries: [delivery],
    } = await fixture('http://127.0.0.1:12345')
    const controller = new AbortController()
    const errors: unknown[] = []
    await createWorker(testConfig({ encryptionKey: new Uint8Array(32).fill(2) })).run({
      signal: controller.signal,
      onError(error) {
        errors.push(error)
        controller.abort()
      },
    })
    expect(errors).toMatchObject([{ code: 'INVALID_CONFIG' }])
    expect((await state(delivery!.id)).delivery.attempt_count).toBe(0)
  })

  it('propagates callback errors and exits the worker loop', async () => {
    await fixture('http://127.0.0.1:12345')
    const controller = new AbortController()
    await expect(
      createWorker(testConfig({ encryptionKey: new Uint8Array(32).fill(2) })).run({
        signal: controller.signal,
        async onError() {
          throw new Error('stop worker')
        },
      }),
    ).rejects.toThrow('stop worker')
  })
})
