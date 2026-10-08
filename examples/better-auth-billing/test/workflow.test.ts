import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'

async function unusedPort() {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
async function closeServer(server?: Server) {
  if (!server) return
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
async function stopWorker(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const done = once(child, 'exit')
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  try {
    await done
  } finally {
    clearTimeout(timer)
  }
}

test('setup persists supplied values for a fresh process and never replaces an existing file', async () => {
  const { initializeEnv } = await import('../src/setup.ts')
  const directory = mkdtempSync(join(tmpdir(), 'billing-setup-'))
  const cwd = process.cwd()
  const values = {
    DATABASE_URL: 'postgres://custom:local@127.0.0.1:55449/custom_billing',
    APP_PORT: '4329',
    RECEIVER_PORT: '4429',
    BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
    RECEIVER_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  }
  const original = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]))
  try {
    Object.assign(process.env, values)
    process.chdir(directory)
    initializeEnv()
    const file = readFileSync('.env', 'utf8')
    const freshEnv = { ...process.env }
    for (const name of Object.keys(values)) delete freshEnv[name]
    const loaded = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--env-file=.env',
          '-e',
          `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(values))}.map(name => [name, process.env[name]]))))`,
        ],
        { env: freshEnv, encoding: 'utf8' },
      ),
    )
    assert.deepEqual(loaded, values)
    process.env.APP_PORT = '4330'
    initializeEnv()
    assert.equal(readFileSync('.env', 'utf8'), file)
  } finally {
    process.chdir(cwd)
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(directory, { recursive: true })
  }
})

test(
  'real Better Auth billing workflow with a separate delivery worker',
  { timeout: 90_000 },
  async (t) => {
    const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
    assert.ok(adminUrl, 'Set TEST_DATABASE_URL or run npm run setup to create .env first')
    const admin = new Pool({ connectionString: adminUrl })
    const databaseName = `billing_test_${randomUUID().replaceAll('-', '')}`
    const url = new URL(adminUrl)
    url.pathname = `/${databaseName}`
    process.env.DATABASE_URL = url.toString()
    process.env.APP_PORT = String(await unusedPort())
    process.env.RECEIVER_PORT = String(await unusedPort())
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('base64')
    process.env.RECEIVER_ENCRYPTION_KEY = randomBytes(32).toString('base64')
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    let context: Awaited<ReturnType<typeof import('../src/context.ts').createContext>> | undefined
    let appServer: Server | undefined
    let receiverServer: Server | undefined
    let worker: ChildProcess | undefined
    let workerLog = ''
    const origin = `http://127.0.0.1:${process.env.APP_PORT}`
    const receiverOrigin = `http://127.0.0.1:${process.env.RECEIVER_PORT}`
    try {
      const { createPool, transaction } = await import('../src/database.ts')
      const { migrate } = await import('../src/setup.ts')
      const migrationPool = createPool()
      try {
        await migrate(migrationPool)
        await migrate(migrationPool)
      } finally {
        await migrationPool.end()
      }
      context = await (await import('../src/context.ts')).createContext()
      appServer = (await import('../src/app.ts'))
        .createApp(context)
        .listen(Number(process.env.APP_PORT), '127.0.0.1')
      receiverServer = (await import('../src/receiver-app.ts'))
        .createReceiver(context.pool)
        .listen(Number(process.env.RECEIVER_PORT), '127.0.0.1')
      await Promise.all([once(appServer, 'listening'), once(receiverServer, 'listening')])
      async function request(path: string, cookie = '', body?: unknown, customOrigin = origin) {
        const response = await fetch(`${origin}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            origin: customOrigin,
            cookie,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        const text = await response.text()
        return {
          status: response.status,
          data: text ? JSON.parse(text) : null,
          cookie: response.headers
            .getSetCookie()
            .map((value) => value.split(';')[0])
            .join('; '),
        }
      }
      async function signUp(name: string) {
        const result = await request('/api/auth/sign-up/email', '', {
          name,
          email: `${name}-${randomUUID()}@example.com`,
          password: 'billing-test-password-42',
        })
        assert.equal(result.status, 200, JSON.stringify(result.data))
        assert.ok(result.cookie)
        return { ...result, email: result.data.user.email }
      }
      const alice = await signUp('Alice')
      const bob = await signUp('Bob')
      const routeId = randomUUID()
      const created = await request('/api/auth/good-webhooks/create', alice.cookie, {
        url: `${receiverOrigin}/webhooks/${routeId}`,
        description: 'Alice accounting',
        eventTypes: ['invoice.created', 'invoice.paid'],
      })
      assert.equal(created.status, 200, JSON.stringify(created.data))
      const endpointId = created.data.endpoint.id as string
      const scope = context.delivery.forScope({ type: 'user', id: alice.data.user.id })
      async function receiptCount() {
        const result = await context!.pool.query(
          'SELECT count(*)::int AS count FROM billing_receipts WHERE endpoint_id = $1',
          [endpointId],
        )
        return result.rows[0].count as number
      }
      await t.test(
        'endpoint management requires a session and enforces personal scopes',
        async () => {
          assert.equal((await request('/api/workspace')).status, 401)
          assert.equal((await request('/api/auth/good-webhooks/list', '', {})).status, 401)
          assert.equal(
            (
              await request(
                '/api/auth/good-webhooks/list',
                alice.cookie,
                {},
                'https://attacker.example',
              )
            ).status,
            403,
          )
          assert.equal(
            (await request('/api/auth/good-webhooks/list', alice.cookie, { scope: null })).status,
            403,
          )
          assert.equal(
            (
              await request('/api/auth/good-webhooks/list', bob.cookie, {
                scope: { type: 'user', id: alice.data.user.id },
              })
            ).status,
            403,
          )
          assert.equal(
            (await request('/api/auth/good-webhooks/get', bob.cookie, { id: endpointId })).status,
            404,
          )
          assert.equal(
            (await request('/api/auth/good-webhooks/pause', bob.cookie, { id: endpointId })).status,
            404,
          )
          const listing = await request('/api/auth/good-webhooks/list', alice.cookie, {})
          assert.equal(listing.data.length, 1)
          assert.equal('secret' in listing.data[0], false)
          assert.equal('encryptedSecret' in listing.data[0], false)
          assert.deepEqual((await request('/api/auth/good-webhooks/list', bob.cookie, {})).data, [])
        },
      )
      await t.test(
        'secret transfer validates ownership, signing material, and same origin',
        async () => {
          assert.equal(
            (
              await request('/api/receivers/connect', bob.cookie, {
                endpointId,
                secret: created.data.secret,
              })
            ).status,
            404,
          )
          assert.equal(
            (
              await request('/api/receivers/connect', alice.cookie, {
                endpointId,
                secret: 'whsec_wrong',
              })
            ).status,
            400,
          )
          assert.equal(
            (
              await request(
                '/api/receivers/connect',
                alice.cookie,
                { endpointId, secret: created.data.secret },
                'https://attacker.example',
              )
            ).status,
            403,
          )
          assert.equal(
            (
              await request('/api/receivers/connect', alice.cookie, {
                endpointId,
                secret: created.data.secret,
              })
            ).status,
            200,
          )
          const stored = await context!.pool.query(
            'SELECT encrypted_secret FROM billing_receivers WHERE endpoint_id = $1',
            [endpointId],
          )
          assert.notEqual(stored.rows[0].encrypted_secret, created.data.secret)
          const state = await request('/api/workspace', alice.cookie)
          assert.ok(!JSON.stringify(state.data).includes(created.data.secret))
        },
      )
      worker = spawn(process.execPath, ['src/worker.ts'], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      worker.stdout?.on('data', (chunk) => {
        workerLog = (workerLog + chunk).slice(-10_000)
      })
      worker.stderr?.on('data', (chunk) => {
        workerLog = (workerLog + chunk).slice(-10_000)
      })
      async function terminal(eventId: string, status = 'succeeded') {
        const deadline = Date.now() + 15_000
        while (Date.now() < deadline) {
          if (worker!.exitCode !== null) assert.fail(`Worker exited: ${workerLog}`)
          const deliveries = await scope.deliveries.list({ eventId })
          const delivery = deliveries.items[0]
          if (delivery?.status === status) return delivery
          await delay(100)
        }
        assert.fail(
          `Timed out waiting for ${status}. ${JSON.stringify(await scope.deliveries.list({ eventId }))}\n${workerLog}`,
        )
      }
      let invoiceId = ''
      let firstDelivery = ''
      await t.test(
        'invoice creation commits its event, sends signed HTTP, and records receiver state',
        async () => {
          assert.equal(
            (
              await request('/api/invoices', alice.cookie, {
                customer: 'Spoof',
                total: 4200,
                ownerId: bob.data.user.id,
              })
            ).status,
            400,
          )
          assert.equal(
            (await request('/api/invoices', alice.cookie, { customer: 'Invalid', total: -1 }))
              .status,
            400,
          )
          const invoice = await request('/api/invoices', alice.cookie, {
            customer: 'Northwind Studio',
            total: 4200,
          })
          assert.equal(invoice.status, 201)
          assert.equal(invoice.data.publication.deliveryCount, 1)
          invoiceId = invoice.data.invoice.id
          const delivered = await terminal(invoice.data.publication.eventId)
          firstDelivery = delivered.id
          const detail = await request(`/api/deliveries/${delivered.id}`, alice.cookie)
          assert.equal(detail.data.attempts[0].responseStatus, 200)
          const state = (await request('/api/workspace', alice.cookie)).data
          assert.equal(state.outcomes.length, 1)
          assert.equal(state.outcomes[0].invoice_id, invoiceId)
          assert.equal(state.outcomes[0].status, 'open')
          assert.equal(await receiptCount(), 1)
          assert.equal(state.requests[0].outcome, 'accepted')
        },
      )
      await t.test(
        'business routes, history, replay, and receiver controls isolate users',
        async () => {
          assert.equal(
            (await request(`/api/invoices/${invoiceId}/pay`, bob.cookie, {})).status,
            404,
          )
          assert.equal((await request(`/api/deliveries/${firstDelivery}`, bob.cookie)).status, 404)
          assert.equal(
            (await request(`/api/deliveries/${firstDelivery}/replay`, bob.cookie, {})).status,
            404,
          )
          assert.equal(
            (await request(`/api/receivers/${endpointId}/mode`, bob.cookie, { mode: 'reject' }))
              .status,
            404,
          )
          assert.equal(
            (
              await request(
                `/api/invoices/${invoiceId}/pay`,
                alice.cookie,
                {},
                'https://attacker.example',
              )
            ).status,
            403,
          )
          const state = (await request('/api/workspace', bob.cookie)).data
          for (const key of ['invoices', 'receivers', 'outcomes', 'requests'])
            assert.deepEqual(state[key], [])
          assert.deepEqual(state.deliveries.items, [])
        },
      )
      await t.test(
        'a later transaction rollback removes both the invoice and publication',
        async () => {
          const before = (await scope.deliveries.list()).items.length
          const { createInvoice } = await import('../src/billing.ts')
          let rolledBackId = ''
          await assert.rejects(
            transaction(context!.pool, async (client) => {
              const result = await createInvoice(client, context!.delivery, alice.data.user.id, {
                customer: 'Rolled back',
                total: 100,
              })
              rolledBackId = result.invoice.id
              assert.equal(result.publication.deliveryCount, 1)
              throw new Error('Business transaction aborted after publication')
            }),
            /Business transaction aborted/,
          )
          assert.equal(
            (
              await context!.pool.query('SELECT id FROM billing_invoices WHERE id = $1', [
                rolledBackId,
              ])
            ).rowCount,
            0,
          )
          assert.equal((await scope.deliveries.list()).items.length, before)
        },
      )
      await t.test(
        'payment event updates the receiver and repeated payment is rejected',
        async () => {
          const paid = await request(`/api/invoices/${invoiceId}/pay`, alice.cookie, {})
          assert.equal(paid.status, 200)
          await terminal(paid.data.publication.eventId)
          assert.equal(
            (await request(`/api/invoices/${invoiceId}/pay`, alice.cookie, {})).status,
            409,
          )
          const state = (await request('/api/workspace', alice.cookie)).data
          assert.equal(state.outcomes[0].status, 'paid')
        },
      )
      await t.test(
        'replaying a success keeps the same event and deduplicates the business outcome',
        async () => {
          const before = (await request('/api/workspace', alice.cookie)).data
          const beforeReceipts = await receiptCount()
          const replay = await request(`/api/deliveries/${firstDelivery}/replay`, alice.cookie, {})
          assert.equal(replay.status, 200)
          assert.equal(replay.data.replayOf, firstDelivery)
          await terminal(replay.data.eventId)
          const after = (await request('/api/workspace', alice.cookie)).data
          assert.equal(await receiptCount(), beforeReceipts)
          assert.equal(after.outcomes.length, before.outcomes.length)
          assert.equal(after.outcomes[0].status, 'paid')
          assert.equal(after.requests[0].outcome, 'duplicate')
        },
      )
      await t.test('HTTP 503 retries exhaust, then a replay succeeds after recovery', async () => {
        assert.equal(
          (await request(`/api/receivers/${endpointId}/mode`, alice.cookie, { mode: 'reject' }))
            .status,
          200,
        )
        const invoice = await request('/api/invoices', alice.cookie, {
          customer: 'Retry customer',
          total: 9900,
        })
        const failed = await terminal(invoice.data.publication.eventId, 'failed')
        assert.equal(failed.attemptCount, 3)
        const attempts = (await request(`/api/deliveries/${failed.id}`, alice.cookie)).data.attempts
        assert.deepEqual(
          attempts.map((attempt: { responseStatus: number }) => attempt.responseStatus),
          [503, 503, 503],
        )
        assert.equal(
          (await request(`/api/receivers/${endpointId}/mode`, alice.cookie, { mode: 'healthy' }))
            .status,
          200,
        )
        const replay = await request(`/api/deliveries/${failed.id}/replay`, alice.cookie, {})
        assert.equal(replay.status, 200)
        await terminal(invoice.data.publication.eventId)
        assert.equal((await request('/api/workspace', alice.cookie)).data.outcomes.length, 2)
      })
      await t.test(
        'a forged signature is rejected without a receipt or business mutation',
        async () => {
          const before = (await request('/api/workspace', alice.cookie)).data
          const beforeReceipts = await receiptCount()
          const bad = await fetch(`${receiverOrigin}/webhooks/${routeId}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'webhook-id': randomUUID(),
              'webhook-signature': 'v1,invalid',
              'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
            },
            body: '{}',
          })
          assert.equal(bad.status, 400)
          const after = (await request('/api/workspace', alice.cookie)).data
          assert.equal(await receiptCount(), beforeReceipts)
          assert.equal(after.outcomes.length, before.outcomes.length)
          assert.equal(after.requests[0].outcome, 'invalid')
        },
      )
      await t.test(
        'pause holds delivery, resume sends it, and removal stops future selection',
        async () => {
          assert.equal(
            (await request('/api/auth/good-webhooks/pause', alice.cookie, { id: endpointId }))
              .status,
            200,
          )
          const invoice = await request('/api/invoices', alice.cookie, {
            customer: 'Paused customer',
            total: 5000,
          })
          await delay(600)
          const pending = (
            await scope.deliveries.list({ eventId: invoice.data.publication.eventId })
          ).items[0]
          assert.equal(pending.attemptCount, 0)
          assert.equal(
            (await request('/api/auth/good-webhooks/resume', alice.cookie, { id: endpointId }))
              .status,
            200,
          )
          await terminal(invoice.data.publication.eventId)
          assert.equal(
            (await request('/api/auth/good-webhooks/remove', alice.cookie, { id: endpointId }))
              .status,
            200,
          )
          assert.deepEqual(
            (await request('/api/auth/good-webhooks/list', alice.cookie, {})).data,
            [],
          )
          const noEndpoint = await request('/api/invoices', alice.cookie, {
            customer: 'No recipients',
            total: 1000,
          })
          assert.equal(noEndpoint.data.publication.deliveryCount, 0)
        },
      )
      await t.test('sign-out revokes the session and sign-in restores access', async () => {
        assert.equal((await request('/api/auth/sign-out', alice.cookie, {})).status, 200)
        assert.equal((await request('/api/workspace', alice.cookie)).status, 401)
        const signedIn = await request('/api/auth/sign-in/email', '', {
          email: alice.email,
          password: 'billing-test-password-42',
        })
        assert.equal(signedIn.status, 200)
        assert.equal((await request('/api/workspace', signedIn.cookie)).status, 200)
      })
    } finally {
      await stopWorker(worker)
      await closeServer(appServer)
      await closeServer(receiverServer)
      await context?.pool.end()
      // Only this process's freshly created database is dropped.
      await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`)
      await admin.end()
    }
  },
)
