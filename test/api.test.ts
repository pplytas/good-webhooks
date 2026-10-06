import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createWebhooks } from '../src/index.js'
import { signWebhook } from '../src/crypto.js'
import { parseWebhook } from '../src/verify.js'
import { events } from '../examples/basic/events.js'
import type { Database } from '../src/types.js'
import { pool, resetDatabase, closeDatabase } from './db.js'

const options = {
  database: pool,
  encryptionKey: new Uint8Array(32).fill(7),
  allowLocalhost: true,
  events: { 'order.created': z.object({ id: z.string(), total: z.number() }) },
}
beforeEach(resetDatabase)
afterAll(closeDatabase)

describe('public server API', () => {
  it('round-trips a maximum-sized persisted producer envelope through the receiver', async () => {
    const definitions = { ...events, large: z.string() }
    const app = createWebhooks({ ...options, events: definitions })
    const endpoint = await app.endpoints.create({
      url: 'http://127.0.0.1:12345',
      eventTypes: ['invoice.paid'],
    })
    for (const input of [
      { type: 'invoice.paid', data: { invoiceId: 'inv_1', amount: 4200 } },
      { type: 'large', data: 'é'.repeat(131071) },
    ] as const) {
      const publication = await app.publish(input)
      const body: string = (
        await pool.query('SELECT body FROM webhooks.events WHERE id=$1', [publication.eventId])
      ).rows[0].body
      const headers = signWebhook({
        id: publication.eventId,
        timestamp: Math.floor(Date.now() / 1000),
        body,
        secrets: [endpoint.secret],
      })
      await expect(
        parseWebhook({ body, headers, secret: endpoint.secret, events: definitions }),
      ).resolves.toMatchObject({ id: publication.eventId, type: input.type, data: input.data })
    }
  })

  it('finds a publication across endpoints without mixing other events or scopes', async () => {
    const app = createWebhooks(options)
    const scope = app.forScope({ type: 'account', id: 'scope-a' })
    const endpoints = await Promise.all(
      [1, 2].map(() =>
        scope.endpoints.create({
          url: 'http://127.0.0.1:12345',
          eventTypes: ['order.created'],
        }),
      ),
    )
    const event = { type: 'order.created' as const, data: { id: 'o1', total: 1 } }
    const published = await scope.publish(event)
    await scope.publish(event)
    const first = await scope.deliveries.list({ eventId: published.eventId, limit: 1 })
    expect(first.items).toHaveLength(1)
    expect(first.items[0]!.eventId).toBe(published.eventId)
    const second = await scope.deliveries.list({
      eventId: published.eventId,
      before: first.nextCursor!,
      limit: 1,
    })
    expect(second.items).toHaveLength(1)
    expect(second.items[0]!.eventId).toBe(published.eventId)
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id)
    expect(second.nextCursor).toBeNull()
    expect(
      (
        await scope.deliveries.list({
          eventId: published.eventId,
          endpointId: endpoints[0]!.endpoint.id,
          status: 'pending',
        })
      ).items,
    ).toHaveLength(1)
    expect(
      (
        await app
          .forScope({ type: 'account', id: 'scope-b' })
          .deliveries.list({ eventId: published.eventId })
      ).items,
    ).toEqual([])
    await expect(scope.deliveries.list({ eventId: 'invalid' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
  })

  it('construction does not connect or start a worker', () => {
    const database = { query: vi.fn(), connect: vi.fn() } as unknown as Database
    const webhooks = createWebhooks({ ...options, database })
    webhooks.forScope({ type: 'account', id: 'scope-a' })
    expect(database.connect).not.toHaveBeenCalled()
    expect(database.query).not.toHaveBeenCalled()
  })

  it('reports missing schema with an actionable code', async () => {
    await pool.query('DROP SCHEMA webhooks CASCADE')
    await expect(createWebhooks(options).check()).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' })
  })

  it('validates payloads at runtime and retains the selected scope', async () => {
    const context = { type: 'account', id: 'scope-a' }
    const scope = createWebhooks(options).forScope(context)
    context.id = 'scope-b'
    await expect(
      scope.publish({ type: 'order.created', data: { id: 7, total: 1 } } as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const result = await scope.publish({ type: 'order.created', data: { id: 'o1', total: 1 } })
    const event = await pool.query('SELECT scope_key,body FROM webhooks.events WHERE id=$1', [
      result.eventId,
    ])
    expect(JSON.parse(event.rows[0].scope_key)).toEqual(['named', 'account', 'scope-a'])
    expect(JSON.parse(event.rows[0].body).data).toEqual({ id: 'o1', total: 1 })
  })

  it('stores validator output and rejects lossy JSON output', async () => {
    const webhooks = createWebhooks({
      ...options,
      events: {
        transformed: z.string().transform((id) => ({ id })),
        invalid: z.string().transform(() => ({ count: NaN })),
      },
    })
    const scope = webhooks.forScope({ type: 'account', id: 'scope-a' })
    const accepted = await scope.publish({ type: 'transformed', data: 'o1' })
    const event = await pool.query('SELECT body FROM webhooks.events WHERE id=$1', [
      accepted.eventId,
    ])
    expect(JSON.parse(event.rows[0].body).data).toEqual({ id: 'o1' })
    await expect(scope.publish({ type: 'invalid', data: 'o1' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
  })

  it('snapshots event identity across asynchronous validation', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const schema = z.object({ id: z.string() }).transform(async (value) => {
      await gate
      return value
    })
    const scope = createWebhooks({
      ...options,
      events: { first: schema, second: z.number() },
    }).forScope({ type: 'account', id: 'scope-a' })
    const input = { type: 'first' as const, data: { id: 'o1' }, idempotencyKey: 'original' }
    const pending = scope.publish(input)
    Object.assign(input, { type: 'second', idempotencyKey: 'changed' })
    release()
    const accepted = await pending
    const row = (
      await pool.query('SELECT type,idempotency_key FROM webhooks.events WHERE id=$1', [
        accepted.eventId,
      ])
    ).rows[0]
    expect(row).toEqual({ type: 'first', idempotency_key: 'original' })
  })

  it('rejects unknown event subscriptions without publishing or creating endpoints', async () => {
    const scope = createWebhooks(options).forScope({ type: 'account', id: 'scope-a' })
    await expect(
      scope.endpoints.create({ url: 'http://localhost:12345', eventTypes: ['missing'] } as never),
    ).rejects.toThrow(/eventTypes/)
    await expect(scope.publish({ type: 'missing', data: {} } as never)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    expect((await pool.query('SELECT id FROM webhooks.events')).rows).toHaveLength(0)
  })
})
