import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createWebhooks } from '../src/index.js'
import { createWorker } from '../src/worker.js'
import { createWorkerStore } from '../src/worker-store.js'
import {
  closeDatabase,
  pool,
  resetDatabase,
  testConfig,
  testManagement,
  testStore as createStore,
} from './db.js'
import { closeReceivers, startReceiver } from './receiver.js'

let status = 200
let requests = 0

beforeEach(async () => {
  status = 200
  requests = 0
  await resetDatabase()
})
afterEach(closeReceivers)
afterAll(closeDatabase)

async function receiver(): Promise<string> {
  const { url } = await startReceiver((_request, response) => {
    requests++
    response.writeHead(status).end()
  })
  return url
}
/** Publish one event to a new endpoint in the scope and return both IDs. */
async function publish(url: string, scope = 'scope-a') {
  const store = createStore()
  const { endpoint } = await store.createEndpoint(scope, { url, eventTypes: ['test.sent'] })
  await store.publish(scope, { type: 'test.sent', data: {} })
  const delivery = (await store.listDeliveries(scope)).items.find(
    (item) => item.endpointId === endpoint.id,
  )!
  return { endpointId: endpoint.id, deliveryId: delivery.id }
}
async function row(id: string) {
  return (
    await pool.query<{
      status: string
      attempt_count: number
      created_at: Date
      window_started_at: Date | null
      last_error: string | null
    }>('SELECT * FROM public.webhook_deliveries WHERE id=$1', [id])
  ).rows[0]!
}
async function due() {
  await pool.query(
    "UPDATE public.webhook_deliveries SET next_attempt_at=now()-interval '1 second' WHERE status='pending'",
  )
}

describe('pause and the retry window', () => {
  it('retries a delivery that waited behind a pause longer than retry.maxAgeMs', async () => {
    const url = await receiver()
    const { endpointId, deliveryId } = await publish(url)
    const store = createStore()
    const worker = createWorker(testConfig())
    await store.pauseEndpoint('scope-a', endpointId)
    expect((await worker.runOnce()).claimed).toBe(0)
    expect((await row(deliveryId)).window_started_at).toBeNull()

    // Two hours behind the pause, well past the 60 second maxAgeMs.
    await pool.query("UPDATE public.webhook_deliveries SET created_at=now()-interval '2 hours'")
    await store.resumeEndpoint('scope-a', endpointId)
    await due()
    expect((await worker.runOnce()).succeeded).toBe(1)
    expect(await store.getDelivery('scope-a', deliveryId)).toMatchObject({
      status: 'succeeded',
      attemptCount: 1,
    })
    const resumed = await row(deliveryId)
    expect(resumed.window_started_at).toBeInstanceOf(Date)
    expect(resumed.window_started_at!.getTime()).toBeGreaterThan(
      resumed.created_at.getTime() + 3_600_000,
    )
    expect(requests).toBe(1)

    // Control: the same age without a pause exhausts the window.
    const control = await publish(url, 'scope-b')
    await pool.query(
      `UPDATE public.webhook_deliveries SET created_at=now()-interval '2 hours',
      window_started_at=now()-interval '2 hours' WHERE id=$1`,
      [control.deliveryId],
    )
    expect((await worker.runOnce()).claimed).toBe(0)
    expect(await row(control.deliveryId)).toMatchObject({
      status: 'failed',
      last_error: 'Delivery retry budget expired',
    })
    expect(requests).toBe(1)
  })

  it('changes nothing observable for a short owner pause', async () => {
    const config = testConfig({ retryDelaysMs: [30_000], maxAgeMs: 3_600_000 })
    const worker = createWorker(config)
    status = 500
    const { endpointId, deliveryId } = await publish(await receiver())
    expect((await worker.runOnce()).retried).toBe(1)
    const store = createStore(config)
    const before = await store.getDelivery('scope-a', deliveryId)
    const window = (await row(deliveryId)).window_started_at
    expect(before).toMatchObject({ status: 'pending', attemptCount: 1 })

    await store.pauseEndpoint('scope-a', endpointId)
    // The retry is due during the pause, so the worker sees the paused endpoint and defers.
    await due()
    expect((await worker.runOnce()).claimed).toBe(0)
    expect(await row(deliveryId)).toMatchObject({
      status: 'pending',
      attempt_count: 1,
      window_started_at: null,
    })
    expect(requests).toBe(1)
    await store.resumeEndpoint('scope-a', endpointId)
    expect(await store.getDelivery('scope-a', deliveryId)).toMatchObject({
      status: before.status,
      attemptCount: before.attemptCount,
    })

    status = 200
    await due()
    expect((await worker.runOnce()).succeeded).toBe(1)
    expect(await store.getDelivery('scope-a', deliveryId)).toMatchObject({
      status: 'succeeded',
      attemptCount: 2,
    })
    // Only the window end moved, by the length of the pause; nothing the client sees changed.
    const resumed = (await row(deliveryId)).window_started_at!
    expect(resumed.getTime()).toBeGreaterThan(window!.getTime())
  })

  it('delivers work queued behind an automatic pause after resume', async () => {
    const app = createWebhooks({
      database: pool,
      encryptionKey: new Uint8Array(32).fill(7),
      events: { 'invoice.paid': z.object({ id: z.string() }) },
      allowLocalhost: true,
      retry: { delaysMs: [10, 10], maxAgeMs: 60_000 },
    })
    const user = app.forScope({ type: 'user', id: 'owner' })
    status = 410
    const { endpoint } = await user.endpoints.create({
      url: await receiver(),
      eventTypes: ['invoice.paid'],
    })
    await user.publish({ type: 'invoice.paid', data: { id: 'inv_1' } })
    expect((await app.worker.runOnce()).failed).toBe(1)
    expect((await user.endpoints.get(endpoint.id)).pauseReason).toBe('gone')

    const { eventId } = await user.publish({ type: 'invoice.paid', data: { id: 'inv_2' } })
    expect((await app.worker.runOnce()).claimed).toBe(0)
    const queued = (await user.deliveries.list()).items.find((item) => item.eventId === eventId)!
    expect((await row(queued.id)).window_started_at).toBeNull()

    await pool.query("UPDATE public.webhook_deliveries SET created_at=now()-interval '2 hours'")
    status = 200
    await user.endpoints.resume(endpoint.id)
    await due()
    expect((await app.worker.runOnce()).succeeded).toBe(1)
    expect(await user.deliveries.get(queued.id)).toMatchObject({
      status: 'succeeded',
      attemptCount: 1,
    })
  })

  it('keeps the window when a stop request interrupts the endpoint lookup', async () => {
    const { deliveryId } = await publish('http://127.0.0.1:12345')
    const before = (await row(deliveryId)).window_started_at
    const controller = new AbortController()
    const source = testManagement().source
    const storage = createWorkerStore(
      testConfig({
        source: {
          ...source,
          // The stop arrives during the lookup, which resolve() reports as paused.
          resolveEndpoint: () => {
            controller.abort()
            return new Promise(() => undefined)
          },
        },
      }),
    )
    expect((await storage.claim(controller.signal)).claims).toEqual([])
    expect(await row(deliveryId)).toMatchObject({ status: 'pending', window_started_at: before })
  })

  it('still prunes by retentionMs while the window is cleared', async () => {
    const { endpointId, deliveryId } = await publish('http://127.0.0.1:12345')
    await createStore().pauseEndpoint('scope-a', endpointId)
    const worker = createWorker(testConfig())
    expect((await worker.runOnce()).claimed).toBe(0)
    expect(await row(deliveryId)).toMatchObject({ status: 'pending', window_started_at: null })
    await pool.query("UPDATE public.webhook_events SET created_at=now()-interval '2 days'")
    expect(await worker.prune()).toBe(1)
    expect((await pool.query('SELECT * FROM public.webhook_deliveries')).rows).toEqual([])
  })

  it('returns an expired lookup lease to pending when the window is cleared', async () => {
    const url = 'http://127.0.0.1:12345'
    const waiting = await publish(url)
    const aged = await publish(url, 'scope-b')
    await pool.query(
      `UPDATE public.webhook_deliveries SET status='in_flight',preparing=true,claim_token=gen_random_uuid(),
      lease_expires_at=now()-interval '1 second',created_at=now()-interval '2 hours',
      window_started_at=CASE WHEN id=$1 THEN NULL ELSE now()-interval '2 hours' END`,
      [waiting.deliveryId],
    )
    await createWorkerStore(testConfig()).recoverExpired()
    expect(await row(waiting.deliveryId)).toMatchObject({
      status: 'pending',
      window_started_at: null,
      last_error: 'Endpoint lookup lease expired before sending',
    })
    expect((await row(aged.deliveryId)).status).toBe('failed')
  })
})
