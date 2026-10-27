import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createWebhooks, type DeliveryStats } from '../src/index.js'
import { createStore } from '../src/store.js'
import { closeDatabase, pool, resetDatabase, testConfig } from './db.js'
import { closeReceivers, startReceiver } from './receiver.js'

const options = {
  database: pool,
  encryptionKey: new Uint8Array(32).fill(7),
  allowLocalhost: true,
  events: { 'order.created': z.object({ id: z.string() }) },
}
const empty: DeliveryStats = {
  deliveries: { pending: 0, in_flight: 0, succeeded: 0, failed: 0, cancelled: 0 },
  oldestPendingAgeMs: null,
  attemptsLastHour: { started: 0, succeeded: 0, retry: 0, failed: 0, abandoned: 0 },
}

beforeEach(resetDatabase)
afterEach(closeReceivers)
afterAll(closeDatabase)

/** A loopback receiver that always answers with this status. */
async function receiver(status: number) {
  const { url } = await startReceiver((request, response) => {
    request.resume()
    request.on('end', () => {
      response.statusCode = status
      response.end()
    })
  })
  return url
}
async function deliveryIds(endpointId: string) {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id::text FROM public.webhook_deliveries WHERE endpoint_id=$1 ORDER BY id',
    [endpointId],
  )
  return rows.map(({ id }) => id)
}

describe('delivery stats', () => {
  it('reports zeros and no pending age for an empty scope', async () => {
    const app = createWebhooks(options)
    expect(await app.deliveries.stats()).toEqual(empty)
    expect(await app.forScope({ type: 'organization', id: 'org-1' }).deliveries.stats()).toEqual(
      empty,
    )
  })

  it('counts deliveries by status through publish, delivery, failure, cancellation, and replay', async () => {
    const app = createWebhooks({ ...options, retry: { delaysMs: [] } })
    const subscribe = async (url: string) =>
      (await app.endpoints.create({ url, eventTypes: ['order.created'] })).endpoint
    await subscribe(await receiver(200))
    const failing = await subscribe(await receiver(500))
    const removed = await subscribe(await receiver(200))
    const paused = await subscribe(await receiver(200))
    await app.endpoints.pause(paused.id)
    for (const id of ['order-1', 'order-2'])
      await app.publish({ type: 'order.created', data: { id } })
    expect((await app.deliveries.stats()).deliveries).toEqual({
      ...empty.deliveries,
      pending: 8,
    })

    await app.endpoints.remove(removed.id)
    for (let run = 0; run < 3; run++) await app.worker.runOnce()
    const delivered = await app.deliveries.stats()
    expect(delivered.deliveries).toEqual({
      pending: 2,
      in_flight: 0,
      succeeded: 2,
      failed: 2,
      cancelled: 2,
    })
    expect(delivered.attemptsLastHour).toEqual({
      ...empty.attemptsLastHour,
      succeeded: 2,
      failed: 2,
    })

    const [failed] = await deliveryIds(failing.id)
    await app.deliveries.replay(failed!)
    const [, queued] = await deliveryIds(paused.id)
    await pool.query("UPDATE public.webhook_deliveries SET status='in_flight' WHERE id=$1", [
      queued,
    ])
    expect((await app.deliveries.stats()).deliveries).toEqual({
      pending: 2,
      in_flight: 1,
      succeeded: 2,
      failed: 2,
      cancelled: 2,
    })
  })

  it('reports the age of the oldest pending delivery from the database clock', async () => {
    const app = createWebhooks(options)
    const { endpoint } = await app.endpoints.create({
      url: await receiver(200),
      eventTypes: ['order.created'],
    })
    await app.endpoints.pause(endpoint.id)
    for (const id of ['order-1', 'order-2', 'order-3'])
      await app.publish({ type: 'order.created', data: { id } })
    const [oldest, finished, newest] = await deliveryIds(endpoint.id)
    const fresh = (await app.deliveries.stats()).oldestPendingAgeMs!
    expect(fresh).toBeGreaterThanOrEqual(0)
    expect(fresh).toBeLessThan(60_000)

    await pool.query(
      `UPDATE public.webhook_deliveries SET created_at=statement_timestamp()-interval '10 minutes' WHERE id=$1`,
      [oldest],
    )
    // An older delivery that is no longer pending does not count.
    await pool.query(
      `UPDATE public.webhook_deliveries SET status='succeeded',created_at=statement_timestamp()-interval '1 day' WHERE id=$1`,
      [finished],
    )
    const age = (await app.deliveries.stats()).oldestPendingAgeMs!
    expect(Number.isInteger(age)).toBe(true)
    expect(age).toBeGreaterThanOrEqual(600_000)
    expect(age).toBeLessThan(660_000)

    await pool.query(
      "UPDATE public.webhook_deliveries SET status='failed' WHERE id=ANY($1::bigint[])",
      [[oldest, newest]],
    )
    expect(await app.deliveries.stats()).toMatchObject({
      deliveries: { pending: 0, succeeded: 1, failed: 2 },
      oldestPendingAgeMs: null,
    })
  })

  it('counts attempts started in the last hour by outcome, including attempts in flight', async () => {
    const app = createWebhooks(options)
    for (const status of [200, 503])
      await app.endpoints.create({ url: await receiver(status), eventTypes: ['order.created'] })
    await app.publish({ type: 'order.created', data: { id: 'order-1' } })
    await app.worker.runOnce()
    expect((await app.deliveries.stats()).attemptsLastHour).toEqual({
      ...empty.attemptsLastHour,
      succeeded: 1,
      retry: 1,
    })

    // The retried delivery's second attempt is in flight; the success is moved out of the window.
    const { rows } = await pool.query<{ id: string; status: string }>(
      'SELECT id::text,status FROM public.webhook_deliveries ORDER BY id',
    )
    const succeeded = rows.find((row) => row.status === 'succeeded')!.id
    const retrying = rows.find((row) => row.status === 'pending')!.id
    await pool.query(
      `UPDATE public.webhook_attempts SET started_at=statement_timestamp()-interval '2 hours' WHERE delivery_id=$1`,
      [succeeded],
    )
    await pool.query('INSERT INTO public.webhook_attempts(delivery_id,number) VALUES ($1,2)', [
      retrying,
    ])
    expect((await app.deliveries.stats()).attemptsLastHour).toEqual({
      ...empty.attemptsLastHour,
      started: 1,
      retry: 1,
    })
  })

  it('never counts another scope', async () => {
    const app = createWebhooks(options)
    const scoped = app.forScope({ type: 'organization', id: 'org-1' })
    const other = app.forScope({ type: 'organization', id: 'org-2' })
    const url = await receiver(200)
    await app.endpoints.create({ url, eventTypes: ['order.created'] })
    await scoped.endpoints.create({ url, eventTypes: ['order.created'] })
    await scoped.endpoints.create({ url, eventTypes: ['order.created'] })
    await app.publish({ type: 'order.created', data: { id: 'order-1' } })
    await scoped.publish({ type: 'order.created', data: { id: 'order-1' } })
    await scoped.publish({ type: 'order.created', data: { id: 'order-2' } })
    await app.worker.runOnce()
    await scoped.publish({ type: 'order.created', data: { id: 'order-3' } })

    const own = await app.deliveries.stats()
    expect(own.deliveries).toEqual({ ...empty.deliveries, succeeded: 1 })
    expect(own.oldestPendingAgeMs).toBeNull()
    expect(own.attemptsLastHour).toEqual({ ...empty.attemptsLastHour, succeeded: 1 })
    const named = await scoped.deliveries.stats()
    expect(named.deliveries).toEqual({ ...empty.deliveries, succeeded: 4, pending: 2 })
    expect(named.oldestPendingAgeMs).toBeLessThan(60_000)
    expect(named.attemptsLastHour).toEqual({ ...empty.attemptsLastHour, succeeded: 4 })
    expect(await other.deliveries.stats()).toEqual(empty)
  })

  it('rejects an invalid scope before querying', async () => {
    const store = createStore(testConfig())
    for (const key of ['', ' ', 'a\0b', 'x'.repeat(2049), undefined, 42])
      await expect(store.stats(key as string)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const app = createWebhooks(options)
    expect(() => app.forScope({ type: 'organization', id: '' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    )
  })
})
