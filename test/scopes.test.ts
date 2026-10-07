import { once } from 'node:events'
import { createServer } from 'node:http'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createWebhooks, verifyWebhook } from '../src/index.js'
import type { Database } from '../src/types.js'
import { closeDatabase, pool, resetDatabase } from './db.js'

const options = {
  database: pool,
  encryptionKey: new Uint8Array(32).fill(7),
  allowLocalhost: true,
  events: { 'order.created': z.object({ id: z.string() }) },
}
const endpointInput = {
  url: 'http://127.0.0.1:12345',
  eventTypes: ['order.created'] as const,
}
const event = {
  type: 'order.created' as const,
  data: { id: 'o1' },
  idempotencyKey: 'same-business-event',
}
function clients(app = createWebhooks(options)) {
  return [
    app,
    app.forScope({ type: 'user', id: '42' }),
    app.forScope({ type: 'organization', id: '42' }),
    app.forScope({ type: 'application', id: '42' }),
  ]
}

beforeEach(resetDatabase)
afterAll(closeDatabase)

describe('optional scope isolation', () => {
  it('keeps fanout, idempotency, management, and history within each selected scope', async () => {
    const views = clients()
    const fixtures = await Promise.all(
      views.map(async (client) => {
        const { endpoint } = await client.endpoints.create(endpointInput)
        const published = await client.publish(event)
        expect(published.deliveryCount).toBe(1)
        expect(await client.publish(event)).toEqual({ ...published, duplicate: true })
        const [delivery] = (await client.deliveries.list()).items
        expect(delivery?.endpointId).toBe(endpoint.id)
        return { endpoint, published, delivery: delivery! }
      }),
    )
    expect(new Set(fixtures.map(({ published }) => published.eventId)).size).toBe(views.length)
    await pool.query("UPDATE public.webhook_deliveries SET status='succeeded'")
    for (const [i, client] of views.entries()) {
      const own = fixtures[i]!
      expect((await client.endpoints.list()).map(({ id }) => id)).toEqual([own.endpoint.id])
      expect((await client.deliveries.list()).items.map(({ id }) => id)).toEqual([own.delivery.id])
      for (const [j, foreign] of fixtures.entries()) {
        if (i === j) continue
        const operations = [
          () => client.endpoints.get(foreign.endpoint.id),
          () => client.endpoints.update(foreign.endpoint.id, { description: 'foreign' }),
          () => client.endpoints.pause(foreign.endpoint.id),
          () => client.endpoints.resume(foreign.endpoint.id),
          () => client.endpoints.remove(foreign.endpoint.id),
          () => client.endpoints.rotateSecret(foreign.endpoint.id),
          () => client.deliveries.get(foreign.delivery.id),
          () => client.deliveries.replay(foreign.delivery.id),
        ]
        for (const operation of operations)
          await expect(operation()).rejects.toMatchObject({ code: 'NOT_FOUND' })
        expect((await client.deliveries.list({ endpointId: foreign.endpoint.id })).items).toEqual(
          [],
        )
        expect(
          (await client.deliveries.list({ eventId: foreign.published.eventId })).items,
        ).toEqual([])
      }
      const replay = await client.deliveries.replay(own.delivery.id)
      expect(replay.eventId).toBe(own.published.eventId)
      expect(replay.endpointId).toBe(own.endpoint.id)
    }
  })

  it('never falls back or broadcasts between application and named scopes', async () => {
    const app = createWebhooks(options)
    const user = app.forScope({ type: 'user', id: '42' })
    const { endpoint } = await app.endpoints.create(endpointInput)
    expect((await user.publish(event)).deliveryCount).toBe(0)
    expect((await app.deliveries.list()).items).toEqual([])
    await app.endpoints.remove(endpoint.id)
    await user.endpoints.create(endpointInput)
    expect((await app.publish(event)).deliveryCount).toBe(0)
    expect((await user.deliveries.list()).items).toEqual([])
  })

  it('preserves exact identifiers without delimiter, default, or case collisions', async () => {
    const app = createWebhooks(options)
    const references = [
      { type: 'user:org', id: '42' },
      { type: 'user', id: 'org:42' },
      { type: 'application', id: '["application"]' },
      { type: 'default', id: 'default' },
      { type: 'user', id: '42' },
      { type: 'User', id: '42' },
      { type: 'user', id: ' 42 ' },
      { type: '\"\\\n[]', id: '\"\\\n[]' },
    ]
    const views = [app, ...references.map((reference) => app.forScope(reference))]
    const results = await Promise.all(views.map((client) => client.publish(event)))
    expect(new Set(results.map(({ eventId }) => eventId)).size).toBe(views.length)
    for (const [i, reference] of references.entries()) {
      expect((await app.forScope(reference).publish(event)).eventId).toBe(results[i + 1]!.eventId)
    }
  })

  it.each([
    undefined,
    null,
    '',
    [],
    {},
    { id: '42' },
    { type: 'user' },
    { type: '', id: '42' },
    { type: 'user', id: '  ' },
    { type: 3, id: '42' },
    { type: 'user', id: 42 },
    { type: 'x'.repeat(65), id: '42' },
    { type: 'user', id: 'x'.repeat(201) },
    { type: 'user\0', id: '42' },
    { type: 'user', id: '42\0' },
  ])('rejects invalid scope %j before database access', (reference) => {
    const database = { query: vi.fn(), connect: vi.fn() } as unknown as Database
    const app = createWebhooks({ ...options, database })
    expect(() => app.forScope(reference as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    )
    expect(database.query).not.toHaveBeenCalled()
    expect(database.connect).not.toHaveBeenCalled()
  })

  it('snapshots both scope fields across async validation and concurrent requests', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const app = createWebhooks({
      ...options,
      events: {
        'order.created': z.object({ id: z.string() }).transform(async (data) => {
          await gate
          return data
        }),
      },
    })
    const reference = { type: 'user', id: '42' }
    const original = app.forScope(reference)
    const { endpoint } = await original.endpoints.create(endpointInput)
    const pending = original.publish(event)
    Object.assign(reference, { type: 'organization', id: '43' })
    const other = app.forScope(reference)
    const concurrent = other.publish(event)
    release()
    const [first, second] = await Promise.all([pending, concurrent])
    expect(first.deliveryCount).toBe(1)
    expect(second.deliveryCount).toBe(0)
    expect(first.eventId).not.toBe(second.eventId)
    expect((await original.deliveries.list()).items[0]?.endpointId).toBe(endpoint.id)
    expect((await other.deliveries.list()).items).toEqual([])
    expect(await app.forScope({ type: 'user', id: '42' }).endpoints.get(endpoint.id)).toEqual(
      endpoint,
    )
    expect(original).not.toHaveProperty('worker')
    expect(original).not.toHaveProperty('check')
    expect(original).not.toHaveProperty('forScope')
  })

  it('shares the application scope across factory instances and preserves it when named scopes are used', async () => {
    const app = createWebhooks(options)
    const { endpoint } = await app.endpoints.create(endpointInput)
    await app.forScope({ type: 'user', id: '42' }).endpoints.create(endpointInput)
    const second = createWebhooks(options)
    expect(await second.endpoints.list()).toEqual([endpoint])
    expect((await second.publish(event)).deliveryCount).toBe(1)
  })

  it('rolls back publications in all scopes with the caller transaction', async () => {
    const views = clients()
    for (const client of views) await client.endpoints.create(endpointInput)
    const transaction = await pool.connect()
    try {
      await transaction.query('BEGIN')
      for (const client of views) {
        expect((await client.publish(event, { transaction })).deliveryCount).toBe(1)
      }
      expect((await pool.query('SELECT id FROM public.webhook_events')).rows).toEqual([])
    } finally {
      await transaction.query('ROLLBACK')
      transaction.release()
    }
    for (const client of views) {
      expect((await client.deliveries.list()).items).toEqual([])
      expect((await client.publish(event)).duplicate).toBe(false)
    }
  })

  it('rejects cross-scope delivery coordination, event, and replay relationships in PostgreSQL', async () => {
    const [app, user] = clients()
    const first = await app!.endpoints.create(endpointInput)
    const second = await user!.endpoints.create(endpointInput)
    const publication = await app!.publish(event)
    const other = await user!.publish(event)
    const delivery = (await app!.deliveries.list()).items[0]!
    const foreign = (await user!.deliveries.list()).items[0]!
    for (const [column, value] of [
      ['endpoint_id', second.endpoint.id],
      ['event_id', other.eventId],
      ['replay_of', foreign.id],
    ] as const) {
      await expect(
        pool.query(`UPDATE public.webhook_deliveries SET ${column}=$1 WHERE id=$2`, [
          value,
          delivery.id,
        ]),
      ).rejects.toMatchObject({ code: '23503' })
    }
    expect((await app!.deliveries.get(delivery.id)).endpointId).toBe(first.endpoint.id)
    expect((await app!.deliveries.get(delivery.id)).eventId).toBe(publication.eventId)
  })

  it('delivers signed requests and prunes history across application and named scopes', async () => {
    const received: string[] = []
    const secrets = new Map<string, string>()
    const receiver = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        try {
          const body = Buffer.concat(chunks)
          verifyWebhook({ body, headers: request.headers, secret: secrets.get(request.url!)! })
          received.push(JSON.parse(body.toString()).id)
          response.end('accepted')
        } catch {
          response.writeHead(400).end('invalid')
        }
      })
    })
    receiver.listen(0, '127.0.0.1')
    await once(receiver, 'listening')
    const address = receiver.address()
    if (!address || typeof address === 'string') throw new Error('Receiver did not bind')
    try {
      const app = createWebhooks(options)
      const views = clients(app)
      const eventIds: string[] = []
      for (const [i, client] of views.entries()) {
        const { secret } = await client.endpoints.create({
          ...endpointInput,
          url: `http://127.0.0.1:${address.port}/${i}`,
        })
        secrets.set(`/${i}`, secret)
        eventIds.push((await client.publish(event)).eventId)
      }
      expect(await app.worker.tick()).toMatchObject({
        claimed: views.length,
        succeeded: views.length,
      })
      expect(received.sort()).toEqual(eventIds.sort())
      for (const client of views)
        expect((await client.deliveries.list()).items[0]?.status).toBe('succeeded')
      await pool.query("UPDATE public.webhook_events SET created_at=now()-interval '8 days'")
      expect(await app.worker.prune()).toBe(views.length)
      for (const client of views) expect((await client.deliveries.list()).items).toEqual([])
    } finally {
      await new Promise<void>((resolve, reject) =>
        receiver.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })
})
