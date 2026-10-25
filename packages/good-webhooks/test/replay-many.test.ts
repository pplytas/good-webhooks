import { once } from 'node:events'
import { createServer } from 'node:http'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createWebhooks, type WebhookClient } from '../src/index.js'
import { closeDatabase, pool, resetDatabase } from './db.js'

const options = {
  database: pool,
  encryptionKey: new Uint8Array(32).fill(7),
  allowLocalhost: true,
  events: { 'order.created': z.object({ id: z.string() }) },
}
type Client = Pick<WebhookClient<typeof options.events>, 'endpoints' | 'publish' | 'deliveries'>

beforeEach(resetDatabase)
afterAll(closeDatabase)

/** Publishes count events to a new endpoint and returns the original delivery ids, oldest first. */
async function originals(client: Client, count: number, url = 'http://127.0.0.1:9/unreachable') {
  const { endpoint } = await client.endpoints.create({ url, eventTypes: ['order.created'] })
  for (let index = 0; index < count; index++)
    await client.publish({ type: 'order.created', data: { id: `order-${index}` } })
  const { rows } = await pool.query<{ id: string }>(
    'SELECT d.id::text FROM public.webhook_deliveries d WHERE endpoint_id=$1 ORDER BY d.id',
    [endpoint.id],
  )
  return { endpoint, ids: rows.map(({ id }) => id) }
}
async function setStatus(ids: string[], status: string) {
  await pool.query('UPDATE public.webhook_deliveries SET status=$2 WHERE id=ANY($1::bigint[])', [
    ids,
    status,
  ])
}
async function replaysOf(ids: string[]) {
  const { rows } = await pool.query<{ replay_of: string; status: string }>(
    'SELECT replay_of::text,status FROM public.webhook_deliveries WHERE replay_of=ANY($1::bigint[]) ORDER BY id',
    [ids],
  )
  return rows
}
async function deliveryCount() {
  return (await pool.query('SELECT count(*)::integer AS count FROM public.webhook_deliveries'))
    .rows[0]!.count as number
}

describe('bulk replay', () => {
  it('replays failed originals by default, or succeeded ones on request', async () => {
    const app = createWebhooks(options)
    const { endpoint, ids } = await originals(app, 4)
    await setStatus(ids.slice(0, 2), 'failed')
    await setStatus([ids[2]!], 'succeeded')
    expect(await app.deliveries.replayMany({ endpointId: endpoint.id })).toEqual({
      replayed: 2,
      skipped: 0,
      nextCursor: null,
    })
    expect(await replaysOf(ids)).toEqual([
      { replay_of: ids[0], status: 'pending' },
      { replay_of: ids[1], status: 'pending' },
    ])
    expect(
      await app.deliveries.replayMany({ endpointId: endpoint.id, status: 'succeeded' }),
    ).toEqual({ replayed: 1, skipped: 0, nextCursor: null })
    expect((await replaysOf([ids[2]!])).length).toBe(1)
    // The pending original is never a candidate.
    expect(await replaysOf([ids[3]!])).toEqual([])
    const replay = (await app.deliveries.list({ endpointId: endpoint.id })).items[0]!
    expect(replay).toMatchObject({ replayOf: ids[2], status: 'pending', attemptCount: 0 })
  })

  it('filters on createdAt with an inclusive since and an exclusive until', async () => {
    const app = createWebhooks(options)
    const { endpoint, ids } = await originals(app, 3)
    await setStatus(ids, 'failed')
    for (const [index, id] of ids.entries())
      await pool.query('UPDATE public.webhook_deliveries SET created_at=$2 WHERE id=$1', [
        id,
        new Date(Date.UTC(2026, 9, 1 + index)),
      ])
    expect(
      await app.deliveries.replayMany({
        endpointId: endpoint.id,
        since: new Date(Date.UTC(2026, 9, 2)),
        until: new Date(Date.UTC(2026, 9, 3)),
      }),
    ).toMatchObject({ replayed: 1 })
    expect((await replaysOf(ids)).map((row) => row.replay_of)).toEqual([ids[1]])
    expect(
      await app.deliveries.replayMany({
        endpointId: endpoint.id,
        since: new Date(Date.UTC(2026, 9, 3)),
      }),
    ).toMatchObject({ replayed: 1 })
    expect(
      await app.deliveries.replayMany({
        endpointId: endpoint.id,
        until: new Date(Date.UTC(2026, 9, 2)),
      }),
    ).toMatchObject({ replayed: 1 })
    expect((await replaysOf(ids)).length).toBe(3)
  })

  it('never treats a replay as a candidate', async () => {
    const app = createWebhooks(options)
    const { endpoint, ids } = await originals(app, 1)
    await setStatus(ids, 'failed')
    const replay = await app.deliveries.replay(ids[0]!)
    await setStatus([replay.id], 'failed')
    expect(await app.deliveries.replayMany({ endpointId: endpoint.id })).toEqual({
      replayed: 1,
      skipped: 0,
      nextCursor: null,
    })
    expect(await replaysOf([replay.id])).toEqual([])
    expect((await replaysOf(ids)).length).toBe(2)
  })

  it('skips deliveries with a pending or in-flight replay', async () => {
    const app = createWebhooks(options)
    const { endpoint, ids } = await originals(app, 2)
    await setStatus(ids, 'failed')
    const replay = await app.deliveries.replay(ids[0]!)
    expect(await app.deliveries.replayMany({ endpointId: endpoint.id })).toEqual({
      replayed: 1,
      skipped: 1,
      nextCursor: null,
    })
    expect(await app.deliveries.replayMany({ endpointId: endpoint.id })).toEqual({
      replayed: 0,
      skipped: 2,
      nextCursor: null,
    })
    await setStatus([replay.id], 'in_flight')
    expect(await app.deliveries.replayMany({ endpointId: endpoint.id })).toMatchObject({
      replayed: 0,
      skipped: 2,
    })
    expect((await replaysOf([ids[0]!])).length).toBe(1)
    await setStatus([replay.id], 'failed')
    expect(await app.deliveries.replayMany({ endpointId: endpoint.id })).toMatchObject({
      replayed: 1,
      skipped: 1,
    })
  })

  it('serializes concurrent calls without replaying a delivery twice', async () => {
    const app = createWebhooks(options)
    const { endpoint, ids } = await originals(app, 5)
    await setStatus(ids, 'failed')
    const results = await Promise.all([
      app.deliveries.replayMany({ endpointId: endpoint.id }),
      app.deliveries.replayMany({ endpointId: endpoint.id }),
    ])
    expect(results.map((result) => result.replayed).sort()).toEqual([0, 5])
    expect(results.map((result) => result.skipped).sort()).toEqual([0, 5])
    expect((await replaysOf(ids)).map((row) => row.replay_of).sort()).toEqual([...ids].sort())
  })

  it('skips deliveries whose event is outside retention', async () => {
    const app = createWebhooks({ ...options, retentionMs: 86_400_000, retry: { maxAgeMs: 1000 } })
    const { endpoint, ids } = await originals(app, 3)
    await setStatus(ids, 'failed')
    await pool.query(
      `UPDATE public.webhook_events SET created_at=clock_timestamp()-interval '2 days'
      WHERE id=(SELECT event_id FROM public.webhook_deliveries WHERE id=$1)`,
      [ids[1]],
    )
    expect(await app.deliveries.replayMany({ endpointId: endpoint.id })).toEqual({
      replayed: 2,
      skipped: 1,
      nextCursor: null,
    })
    expect((await replaysOf(ids)).map((row) => row.replay_of)).toEqual([ids[0], ids[2]])
  })

  it('pages through candidates newest first with limit and before', async () => {
    const app = createWebhooks(options)
    const { endpoint, ids } = await originals(app, 3)
    await setStatus(ids, 'failed')
    const first = await app.deliveries.replayMany({ endpointId: endpoint.id, limit: 2 })
    expect(first).toEqual({ replayed: 2, skipped: 0, nextCursor: ids[1] })
    expect((await replaysOf(ids)).map((row) => row.replay_of)).toEqual([ids[1], ids[2]])
    expect(
      await app.deliveries.replayMany({
        endpointId: endpoint.id,
        limit: 2,
        before: first.nextCursor!,
      }),
    ).toEqual({ replayed: 1, skipped: 0, nextCursor: null })
    expect((await replaysOf(ids)).length).toBe(3)
  })

  it('examines 100 candidates by default', async () => {
    const app = createWebhooks(options)
    const { endpoint, ids } = await originals(app, 101)
    await setStatus(ids, 'failed')
    expect(await app.deliveries.replayMany({ endpointId: endpoint.id })).toEqual({
      replayed: 100,
      skipped: 0,
      nextCursor: ids[1],
    })
    expect(await app.deliveries.replayMany({ endpointId: endpoint.id, limit: 1000 })).toEqual({
      replayed: 1,
      skipped: 100,
      nextCursor: null,
    })
  })

  it('rejects invalid input before replaying anything', async () => {
    const app = createWebhooks(options)
    const { endpoint, ids } = await originals(app, 1)
    await setStatus(ids, 'failed')
    const endpointId = endpoint.id
    for (const input of [
      undefined,
      {},
      { endpointId: '' },
      { endpointId, status: 'pending' },
      { endpointId, limit: 0 },
      { endpointId, limit: 1001 },
      { endpointId, limit: 1.5 },
      { endpointId, since: new Date('invalid') },
      { endpointId, until: '2026-10-01' },
      { endpointId, since: new Date(Date.UTC(2026, 9, 2)), until: new Date(Date.UTC(2026, 9, 1)) },
      { endpointId, before: 'not-an-id' },
    ])
      await expect(
        app.deliveries.replayMany(input as Parameters<typeof app.deliveries.replayMany>[0]),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(await replaysOf(ids)).toEqual([])
  })

  it('requires an active endpoint and inserts nothing otherwise', async () => {
    const app = createWebhooks(options)
    const { endpoint, ids } = await originals(app, 2)
    await setStatus(ids, 'failed')
    const before = await deliveryCount()
    await app.endpoints.pause(endpoint.id)
    await expect(app.deliveries.replayMany({ endpointId: endpoint.id })).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: 'Bulk replay requires an active endpoint.',
    })
    await app.endpoints.remove(endpoint.id)
    await expect(app.deliveries.replayMany({ endpointId: endpoint.id })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    expect(await deliveryCount()).toBe(before)
  })

  it('works in the application scope and named scopes without crossing them', async () => {
    const app = createWebhooks(options)
    const scoped = app.forScope({ type: 'organization', id: 'org-1' })
    const own = await originals(app, 2)
    const other = await originals(scoped, 3)
    await setStatus([...own.ids, ...other.ids], 'failed')
    await expect(
      app.deliveries.replayMany({ endpointId: other.endpoint.id }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' })
    await expect(
      scoped.deliveries.replayMany({ endpointId: own.endpoint.id }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' })
    expect(await scoped.deliveries.replayMany({ endpointId: other.endpoint.id })).toMatchObject({
      replayed: 3,
    })
    expect(await replaysOf(own.ids)).toEqual([])
    expect(await app.deliveries.replayMany({ endpointId: own.endpoint.id })).toMatchObject({
      replayed: 2,
    })
    expect((await scoped.deliveries.list({ endpointId: other.endpoint.id })).items).toHaveLength(6)
    expect((await app.deliveries.list({ endpointId: own.endpoint.id })).items).toHaveLength(4)
  })

  it('delivers the replays through the worker', async () => {
    const received: string[] = []
    const receiver = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        received.push(String(request.headers['webhook-id']))
        response.end('accepted')
      })
    })
    receiver.listen(0, '127.0.0.1')
    await once(receiver, 'listening')
    const address = receiver.address()
    if (!address || typeof address === 'string') throw new Error('Receiver did not bind')
    try {
      const app = createWebhooks(options)
      const { endpoint, ids } = await originals(app, 3, `http://127.0.0.1:${address.port}/hooks`)
      await setStatus(ids, 'failed')
      expect(await app.deliveries.replayMany({ endpointId: endpoint.id })).toMatchObject({
        replayed: 3,
      })
      // Two per run: the endpoint's default maxInFlight.
      expect(await app.worker.runOnce()).toMatchObject({ claimed: 2, succeeded: 2 })
      expect(await app.worker.runOnce()).toMatchObject({ claimed: 1, succeeded: 1 })
      expect(received).toHaveLength(3)
      expect((await replaysOf(ids)).map((row) => row.status)).toEqual([
        'succeeded',
        'succeeded',
        'succeeded',
      ])
    } finally {
      await new Promise<void>((resolve, reject) =>
        receiver.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })
})
