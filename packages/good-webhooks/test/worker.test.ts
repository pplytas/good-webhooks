import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encryptSecret, generateSecret, signWebhook, verifyWebhook } from '../src/crypto.js'
import { sendWebhook } from '../src/transport.js'
import { createWorker } from '../src/worker.js'
import { createWorkerStore } from '../src/worker-store.js'
import type { ClaimedDelivery, Database } from '../src/types.js'
import {
  closeDatabase,
  pool,
  resetDatabase,
  testConfig,
  testStore as createStore,
  testManagement,
  testScopeKey,
  TEST_ENCRYPTION_KEY,
} from './db.js'

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
  const { endpoint, secret } = await createStore().createEndpoint('scope-a', {
    url,
    eventTypes: ['test.sent'],
  })
  const endpointId = endpoint.id
  await createStore().setEndpointDeliveryOptions('scope-a', endpointId, { maxInFlight })
  const deliveries: { id: string; eventId: string; body: string }[] = []
  for (let n = 0; n < count; n++) {
    const eventId = randomUUID()
    const body = JSON.stringify({ id: eventId, type: 'test.sent', data: { n } })
    await pool.query(
      `INSERT INTO public.webhook_events(id,scope_key,type,body,fingerprint)
      VALUES($1,$3,'test.sent',$2,'fixture')`,
      [eventId, body, testScopeKey('scope-a')],
    )
    const result = await pool.query<{ id: string }>(
      `INSERT INTO public.webhook_deliveries(scope_key,endpoint_id,event_id)
      VALUES($3,$1,$2) RETURNING id::text`,
      [endpointId, eventId, testScopeKey('scope-a')],
    )
    deliveries.push({ id: result.rows[0]!.id, eventId, body })
  }
  return { endpointId, secret, deliveries }
}
async function due() {
  await pool.query(
    "UPDATE public.webhook_deliveries SET next_attempt_at=now()-interval '1 second' WHERE status='pending'",
  )
}
async function expire(claim: ClaimedDelivery) {
  await pool.query(
    "UPDATE public.webhook_deliveries SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [claim.id],
  )
}
async function state(id: string) {
  const delivery = (await pool.query('SELECT * FROM public.webhook_deliveries WHERE id=$1', [id]))
    .rows[0]!
  const attempts = (
    await pool.query('SELECT * FROM public.webhook_attempts WHERE delivery_id=$1 ORDER BY number', [
      id,
    ])
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
  it('skips locked delivery coordination and delivers another scope in the same batch', async () => {
    const received: string[] = []
    const url = await receiver((request, response) => {
      received.push(request.url!)
      request.resume()
      response.end('ok')
    })
    const store = createStore(testConfig())
    for (const id of ['scope-a', 'scope-b']) {
      await store.createEndpoint(id, { url: `${url}/${id}`, eventTypes: ['test.sent'] })
      await store.publish(id, { type: 'test.sent', data: {} })
    }
    await pool.query(
      "UPDATE public.webhook_deliveries SET next_attempt_at=now()-interval '1 minute' WHERE scope_key=$1",
      [testScopeKey('scope-a')],
    )
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        'SELECT endpoint_id FROM public.webhook_endpoint_state WHERE scope_key=$1 FOR UPDATE',
        [testScopeKey('scope-a')],
      )
      const result = await createWorker(testConfig({ concurrency: 1 })).runOnce()
      expect(result).toMatchObject({ claimed: 1, succeeded: 1 })
      expect(received).toEqual(['/webhook/scope-b'])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

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
    const pending = createWorker(testConfig()).runOnce()
    const request = await received.promise
    const started = await state(delivery!.id)
    expect(started.delivery.status).toBe('in_flight')
    expect(started.delivery.attempt_count).toBe(1)
    expect(started.attempts).toMatchObject([{ number: 1, outcome: 'started', finished_at: null }])
    expect(request.body).toBe(delivery!.body)
    verifyWebhook({
      body: request.body,
      headers: request.headers,
      secret,
    })
    expect(request.headers['webhook-id']).toBe(delivery!.eventId)
    finish.resolve()
    expect(await pending).toEqual({ claimed: 1, succeeded: 1, retried: 0, failed: 0, stale: 0 })
    expect((await state(delivery!.id)).attempts).toMatchObject([
      { outcome: 'succeeded', response_body: 'accepted', response_status: 200 },
    ])
  })

  it('enforces an endpoint cap across competing workers and rejects overlapping batches', async () => {
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
    const a = worker.runOnce()
    // Check overlap before either competing worker can finish without claiming work.
    await expect(worker.runOnce()).rejects.toMatchObject({ code: 'INVALID_STATE' })
    const b = createWorker(testConfig({ concurrency: 5 })).runOnce()
    await full.promise
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM public.webhook_deliveries WHERE status='in_flight'",
        )
      ).rows[0].count,
    ).toBe(2)
    finish.resolve()
    const results = await Promise.all([a, b])
    expect(results.reduce((sum, result) => sum + result.claimed, 0)).toBe(2)
    expect(peak).toBe(2)
    expect((await worker.runOnce()).claimed).toBe(2)
  })

  it('prioritizes the oldest due endpoint instead of its UUID', async () => {
    const url = await receiver((_request, response) => response.end())
    const first = await fixture(url)
    const second = await fixture(url)
    const [lower, higher] = [first, second].sort((a, b) => a.endpointId.localeCompare(b.endpointId))
    await pool.query(
      "UPDATE public.webhook_deliveries SET next_attempt_at=now()-interval '1 hour' WHERE endpoint_id=$1",
      [higher!.endpointId],
    )
    const worker = createWorker(testConfig({ concurrency: 1 }))
    expect((await worker.runOnce()).succeeded).toBe(1)
    expect((await state(higher!.deliveries[0]!.id)).delivery.status).toBe('succeeded')
    expect((await state(lower!.deliveries[0]!.id)).delivery.status).toBe('pending')
  })

  it('preserves due priority after locking UUID order when one endpoint could fill the batch', async () => {
    const url = await receiver((_request, response) => response.end())
    const first = await fixture(url, 3, 2)
    const second = await fixture(url, 3, 2)
    const [lower, higher] = [first, second].sort((a, b) => a.endpointId.localeCompare(b.endpointId))
    await pool.query(
      "UPDATE public.webhook_deliveries SET next_attempt_at=now()-interval '1 hour' WHERE id=$1",
      [higher!.deliveries[0]!.id],
    )
    const worker = createWorker(testConfig({ concurrency: 2 }))
    expect((await worker.runOnce()).succeeded).toBe(2)
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
    const {
      claims: [claim],
    } = await storage.claim()
    const accepted = await sendWebhook({
      url,
      body: claim!.body,
      headers: signWebhook({
        id: claim!.eventId,
        timestamp: Math.floor(Date.now() / 1000),
        body: claim!.body,
        secrets: claim!.secrets,
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
    expect((await createWorker(config).runOnce()).succeeded).toBe(1)
    expect(ids).toEqual([delivery!.eventId, delivery!.eventId])
    expect((await state(delivery!.id)).attempts.map((a) => a.outcome)).toEqual([
      'abandoned',
      'succeeded',
    ])
  })

  it('fences an expired token before and after a replacement claim', async () => {
    await fixture('http://127.0.0.1:12345')
    const storage = createWorkerStore(testConfig())
    const {
      claims: [old],
    } = await storage.claim()
    await expire(old!)
    const success = { status: 200, responseBody: 'ok', error: null, retryable: false }
    expect(await storage.complete(old!, success)).toBe('stale')
    await storage.recoverExpired()
    await due()
    const {
      claims: [fresh],
    } = await storage.claim()
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
      expect((await worker.runOnce()).retried).toBe(1)
      const current = await state(delivery!.id)
      expect(current.delivery.attempt_count).toBe(index + 1)
      const scheduled = current.delivery.next_attempt_at.getTime()
      expect(scheduled).toBeGreaterThanOrEqual(before + delay)
      expect(scheduled).toBeLessThanOrEqual(Date.now() + delay * 1.2)
      await due()
    }
    expect((await worker.runOnce()).failed).toBe(1)
    expect((await worker.runOnce()).claimed).toBe(0)
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
    expect((await createWorker(testConfig()).runOnce()).retried).toBe(1)
  })

  it.each([301, 400, 401, 404, 422, 600])('fails permanently on HTTP %i', async (status) => {
    const url = await receiver((_request, response) => {
      response.statusCode = status
      response.end()
    })
    await fixture(url)
    expect((await createWorker(testConfig()).runOnce()).failed).toBe(1)
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
    expect((await createWorker(testConfig({ allowLocalhost: false })).runOnce()).failed).toBe(1)
    expect(requests).toBe(0)
    expect((await state(delivery!.id)).delivery.last_error).toBe('unsafe_url')
  })

  it('retries a timed out request and bounds persisted diagnostics', async () => {
    const url = await receiver(() => undefined)
    const {
      deliveries: [delivery],
    } = await fixture(url)
    expect((await createWorker(testConfig({ timeoutMs: 50 })).runOnce()).retried).toBe(1)
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
    expect(await createWorker(testConfig({ timeoutMs: 50 })).runOnce()).toMatchObject({
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
    expect(await createWorker(testConfig()).runOnce()).toMatchObject({
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

  it('starts all leases together after slow selection and persists attempts before returning', async () => {
    await fixture('http://127.0.0.1:12345', 3, 3)
    let delayedSelections = 0
    let selectionFinishedAt: Date | undefined
    const database: Database = {
      query: pool.query.bind(pool),
      async connect() {
        const client = await pool.connect()
        return {
          release: () => client.release(),
          async query<R extends Record<string, unknown>>(text: string, values?: unknown[]) {
            const result = await client.query<R>(text, values)
            if (text.includes('FOR UPDATE OF d SKIP LOCKED')) {
              delayedSelections++
              await new Promise((resolve) => setTimeout(resolve, 450))
              selectionFinishedAt = (
                await client.query<{ finished_at: Date }>('SELECT clock_timestamp() AS finished_at')
              ).rows[0]!.finished_at
            }
            return result
          },
        }
      },
    }
    const leaseMs = 5000
    const storage = createWorkerStore(testConfig({ database, concurrency: 3, leaseMs }))
    const { claims } = await storage.claim()
    expect(delayedSelections).toBe(1)
    expect(claims).toHaveLength(3)
    expect(selectionFinishedAt).toBeInstanceOf(Date)
    // Compare database timestamps directly. A short lease would also expire during the
    // assertions and serialized completion writes on a busy runner, unrelated to selection.
    const leases = await pool.query<{ fresh: boolean; lease_expires_at: Date }>(
      `SELECT lease_expires_at >= $1::timestamptz + ($2 * interval '1 millisecond') AS fresh,
        lease_expires_at FROM public.webhook_deliveries`,
      [selectionFinishedAt, leaseMs],
    )
    expect(leases.rows).toHaveLength(3)
    expect(leases.rows.every((row) => row.fresh)).toBe(true)
    expect(new Set(leases.rows.map((row) => row.lease_expires_at.getTime())).size).toBe(1)
    const attempts = await pool.query('SELECT * FROM public.webhook_attempts')
    expect(attempts.rows).toHaveLength(3)
    expect(attempts.rows.every((row) => row.outcome === 'started')).toBe(true)
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
    const {
      claims: [claim],
    } = await storage.claim()
    await pool.query("UPDATE public.webhook_deliveries SET created_at=now()-interval '2 minutes'")
    await expire(claim!)
    expect((await createWorker(testConfig()).runOnce()).claimed).toBe(0)
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
    const first = worker.runOnce()
    await received.promise
    await createStore(testConfig()).pauseEndpoint('scope-a', endpointId)
    finish.resolve()
    expect((await first).succeeded).toBe(1)
    expect((await worker.runOnce()).claimed).toBe(0)
    await createStore(testConfig()).resumeEndpoint('scope-a', endpointId)
    await due()
    expect((await worker.runOnce()).succeeded).toBe(1)
  })

  it('allows a prepared request to finish and cancels queued work after observing deletion', async () => {
    const received = deferred()
    const finish = deferred()
    const url = await receiver((_request, response) => {
      received.resolve()
      void finish.promise.then(() => response.end())
    })
    const { endpointId, deliveries } = await fixture(url, 2, 1)
    const worker = createWorker(testConfig())
    const first = worker.runOnce()
    await received.promise
    await createStore(testConfig()).removeEndpoint('scope-a', endpointId)
    finish.resolve()
    expect((await first).succeeded).toBe(1)
    expect((await worker.runOnce()).claimed).toBe(0)
    expect((await state(deliveries[0]!.id)).delivery.status).toBe('succeeded')
    expect((await state(deliveries[1]!.id)).delivery.status).toBe('cancelled')
    expect((await state(deliveries[0]!.id)).attempts[0].outcome).toBe('succeeded')
  })

  it('does not consume an attempt when encryption configuration is wrong', async () => {
    const {
      deliveries: [delivery],
    } = await fixture('http://127.0.0.1:12345')
    await expect(
      createWorker(
        testConfig({
          source: testManagement({ encryptionKey: new Uint8Array(32).fill(2) }).source,
        }),
      ).runOnce(),
    ).rejects.toMatchObject({ errors: [expect.objectContaining({ code: 'INVALID_CONFIG' })] })
    const current = await state(delivery!.id)
    expect(current.delivery).toMatchObject({
      status: 'pending',
      attempt_count: 0,
      claim_token: null,
    })
    expect(current.attempts).toEqual([])
  })

  it('defers an undecryptable endpoint without preventing a healthy sibling from sending', async () => {
    const url = await receiver((_request, response) => response.end('accepted'))
    const healthy = await fixture(url)
    const corrupt = await fixture(url)
    await pool.query('UPDATE public.webhook_endpoints SET secret=$2 WHERE id=$1', [
      corrupt.endpointId,
      'corrupted',
    ])
    await expect(createWorker(testConfig()).runOnce()).rejects.toMatchObject({
      errors: [expect.objectContaining({ code: 'INVALID_CONFIG' })],
    })
    expect((await state(healthy.deliveries[0]!.id)).delivery).toMatchObject({
      status: 'succeeded',
      attempt_count: 1,
    })
    const deferred = await state(corrupt.deliveries[0]!.id)
    expect(deferred.delivery).toMatchObject({
      status: 'pending',
      attempt_count: 0,
      claim_token: null,
    })
    expect(deferred.attempts).toEqual([])
  })

  it('fails an abandoned claim when no retry attempts remain', async () => {
    const {
      deliveries: [delivery],
    } = await fixture('http://127.0.0.1:12345')
    const storage = createWorkerStore(testConfig({ retryDelaysMs: [] }))
    const {
      claims: [claim],
    } = await storage.claim()
    await expire(claim!)
    await storage.recoverExpired()
    expect((await state(delivery!.id)).delivery).toMatchObject({
      status: 'failed',
      attempt_count: 1,
      claim_token: null,
    })
    expect((await state(delivery!.id)).attempts[0].outcome).toBe('abandoned')
    expect(await storage.claim()).toEqual({ claims: [], errors: [] })
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
      `UPDATE public.webhook_endpoints SET previous_secret=$2,
      previous_secret_expires_at=now()+interval '1 hour' WHERE id=$1`,
      [endpointId, encryptSecret(previous, TEST_ENCRYPTION_KEY)],
    )
    const worker = createWorker(testConfig())
    await worker.runOnce()
    await pool.query(
      "UPDATE public.webhook_endpoints SET previous_secret_expires_at=now()-interval '1 second' WHERE id=$1",
      [endpointId],
    )
    await worker.runOnce()
    expect(signatures.map((signature) => signature.split(' ').length)).toEqual([2, 1])
  })

  it('gives a replay fresh retry age while retention stays tied to its event', async () => {
    const url = await receiver((_request, response) => response.end())
    const {
      deliveries: [delivery],
    } = await fixture(url)
    await pool.query("UPDATE public.webhook_events SET created_at=now()-interval '2 minutes'")
    await pool.query(
      "UPDATE public.webhook_deliveries SET status='failed', created_at=now()-interval '2 minutes'",
    )
    const replay = await createStore(testConfig()).replay('scope-a', delivery!.id)
    expect((await createWorker(testConfig()).runOnce()).succeeded).toBe(1)
    expect((await state(replay.id)).delivery.status).toBe('succeeded')
    expect(await createWorker(testConfig({ retentionMs: 60_000 })).prune()).toBe(1)
    expect((await pool.query('SELECT * FROM public.webhook_deliveries')).rows).toEqual([])
  })

  it('prunes expired history with an expired lease and fences its stale completion', async () => {
    const {
      deliveries: [delivery],
    } = await fixture('http://127.0.0.1:12345')
    const storage = createWorkerStore(testConfig())
    const {
      claims: [claim],
    } = await storage.claim()
    await pool.query("UPDATE public.webhook_events SET created_at=now()-interval '2 days'")
    await expire(claim!)
    expect(await createWorker(testConfig()).prune()).toBe(1)
    expect(
      (await pool.query('SELECT id FROM public.webhook_events WHERE id=$1', [delivery!.eventId]))
        .rows,
    ).toEqual([])
    expect((await pool.query('SELECT * FROM public.webhook_attempts')).rows).toEqual([])
    expect(
      await storage.complete(claim!, {
        status: 200,
        responseBody: 'ok',
        error: null,
        retryable: false,
      }),
    ).toBe('stale')
  })

  it('prunes expired events in bounded batches and defers active claims', async () => {
    const {
      deliveries: [delivery],
    } = await fixture('http://127.0.0.1:12345')
    await createWorkerStore(testConfig()).claim()
    await pool.query("UPDATE public.webhook_events SET created_at=now()-interval '2 days'")
    await pool.query(
      `INSERT INTO public.webhook_events(id,scope_key,type,body,fingerprint,created_at)
      SELECT gen_random_uuid(),$1,'test.sent','{}','fixture',now()-interval '2 days' FROM generate_series(1,101)`,
      [testScopeKey('scope-a')],
    )
    const worker = createWorker(testConfig())
    const first = await worker.prune()
    expect(first).toBeGreaterThanOrEqual(99)
    expect(first).toBeLessThanOrEqual(100)
    expect(await worker.prune()).toBe(101 - first)
    expect((await pool.query('SELECT id FROM public.webhook_events')).rows).toEqual([
      { id: delivery!.eventId },
    ])
  })
})

describe('explicit worker lifecycle', () => {
  it('validates the polling interval before starting the loop', async () => {
    const signal = AbortSignal.abort()
    const worker = createWorker(testConfig())
    for (const pollIntervalMs of [1, 5, 60_001, NaN, 10.5]) {
      await expect(worker.run({ signal, pollIntervalMs })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      })
    }
    for (const pollIntervalMs of [10, 1000, 60_000]) {
      await worker.run({ signal, pollIntervalMs })
    }
  })

  it.each(['run', 'runOnce'] as const)(
    'validates %s shutdown grace before accessing the database',
    async (method) => {
      const database = { query: vi.fn(), connect: vi.fn() }
      const worker = createWorker(testConfig({ database }))
      const signal = AbortSignal.abort()
      for (const shutdownGraceMs of [-1, NaN, Infinity, 0.5, 2_147_483_648]) {
        await expect(worker[method]({ signal, shutdownGraceMs })).rejects.toMatchObject({
          code: 'INVALID_INPUT',
        })
      }
      for (const shutdownGraceMs of [0, 30_000, 2_147_483_647]) {
        await worker[method]({ signal, shutdownGraceMs })
      }
      expect(database.query).not.toHaveBeenCalled()
      expect(database.connect).not.toHaveBeenCalled()
    },
  )

  it('does not connect or start polling on construction or with an aborted signal', async () => {
    const database = { query: vi.fn(), connect: vi.fn() }
    const worker = createWorker(testConfig({ database }))
    const controller = new AbortController()
    controller.abort()
    expect(await worker.runOnce({ signal: controller.signal })).toMatchObject({ claimed: 0 })
    await worker.run({ signal: controller.signal })
    expect(database.query).not.toHaveBeenCalled()
    expect(database.connect).not.toHaveBeenCalled()
  })

  it.each(['run', 'runOnce'] as const)(
    '%s lets an active request finish on shutdown without taking another batch',
    async (method) => {
      const received = deferred<ServerResponse>()
      const url = await receiver((_request, response) => received.resolve(response))
      const { deliveries } = await fixture(url, 3)
      const controller = new AbortController()
      const worker = createWorker(testConfig({ concurrency: 1 }))
      const running = worker[method]({ signal: controller.signal })
      const response = await received.promise
      controller.abort()
      await expect(worker.runOnce()).rejects.toMatchObject({ code: 'INVALID_STATE' })
      response.end('accepted during shutdown')
      await running
      expect((await state(deliveries[0]!.id)).attempts).toMatchObject([
        { outcome: 'succeeded', response_body: 'accepted during shutdown' },
      ])
      for (const delivery of deliveries.slice(1)) {
        expect((await state(delivery.id)).delivery).toMatchObject({
          status: 'pending',
          attempt_count: 0,
        })
      }
    },
  )

  it.each(['run', 'runOnce'] as const)(
    '%s with zero grace aborts an active send, persists uncertainty, and leaves the pool usable',
    async (method) => {
      const received = deferred()
      const url = await receiver(() => received.resolve())
      const {
        deliveries: [delivery],
      } = await fixture(url)
      const controller = new AbortController()
      const worker = createWorker(testConfig())
      const running = worker[method]({ signal: controller.signal, shutdownGraceMs: 0 })
      await received.promise
      await expect(worker.runOnce()).rejects.toMatchObject({ code: 'INVALID_STATE' })
      await expect(worker.run({ signal: controller.signal })).rejects.toMatchObject({
        code: 'INVALID_STATE',
      })
      controller.abort()
      await running
      expect((await state(delivery!.id)).delivery.status).toBe('pending')
      expect((await state(delivery!.id)).attempts[0].outcome).toBe('abandoned')
      expect((await pool.query('SELECT 1 AS alive')).rows[0].alive).toBe(1)
    },
  )

  it('releases a reservation when shutdown arrives during its final database read', async () => {
    const {
      deliveries: [delivery],
    } = await fixture('http://127.0.0.1:12345')
    const controller = new AbortController()
    const database: Database = {
      query: pool.query.bind(pool),
      async connect() {
        const client = await pool.connect()
        return {
          release: () => client.release(),
          async query<R extends Record<string, unknown>>(text: string, values?: unknown[]) {
            const result = await client.query<R>(text, values)
            if (text.includes('SELECT clock_timestamp() AS now')) controller.abort()
            return result
          },
        }
      },
    }
    expect(
      await createWorker(testConfig({ database })).runOnce({ signal: controller.signal }),
    ).toMatchObject({ claimed: 0 })
    expect(controller.signal.aborted).toBe(true)
    const stopped = await state(delivery!.id)
    expect(stopped.delivery).toMatchObject({
      status: 'pending',
      preparing: false,
      attempt_count: 0,
      claim_token: null,
    })
    expect(stopped.attempts).toEqual([])
  })

  it('reports operational errors through the callback without consuming attempts', async () => {
    const {
      deliveries: [delivery],
    } = await fixture('http://127.0.0.1:12345')
    const controller = new AbortController()
    const errors: unknown[] = []
    await createWorker(
      testConfig({ source: testManagement({ encryptionKey: new Uint8Array(32).fill(2) }).source }),
    ).run({
      signal: controller.signal,
      onError(error) {
        errors.push(error)
        controller.abort()
      },
    })
    expect(errors).toMatchObject([
      { errors: [expect.objectContaining({ code: 'INVALID_CONFIG' })] },
    ])
    expect((await state(delivery!.id)).delivery.attempt_count).toBe(0)
  })

  it('propagates callback errors and exits the worker loop', async () => {
    await fixture('http://127.0.0.1:12345')
    const controller = new AbortController()
    await expect(
      createWorker(
        testConfig({
          source: testManagement({ encryptionKey: new Uint8Array(32).fill(2) }).source,
        }),
      ).run({
        signal: controller.signal,
        async onError() {
          throw new Error('stop worker')
        },
      }),
    ).rejects.toThrow('stop worker')
  })
})
