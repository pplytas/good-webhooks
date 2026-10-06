import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createWebhooks } from '../src/index.js'
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
  it('construction does not connect or start a worker', () => {
    const database = { query: vi.fn(), connect: vi.fn() } as unknown as Database
    const webhooks = createWebhooks({ ...options, database })
    webhooks.forTenant({ id: 'tenant-a' })
    expect(database.connect).not.toHaveBeenCalled()
    expect(database.query).not.toHaveBeenCalled()
  })

  it('reports missing schema with an actionable code', async () => {
    await pool.query('DROP SCHEMA webhooks CASCADE')
    await expect(createWebhooks(options).check()).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' })
  })

  it('validates payloads at runtime and retains the trusted tenant scope', async () => {
    const context = { id: 'tenant-a' }
    const tenant = createWebhooks(options).forTenant(context)
    context.id = 'tenant-b'
    await expect(
      tenant.publish({ type: 'order.created', data: { id: 7, total: 1 } } as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const result = await tenant.publish({ type: 'order.created', data: { id: 'o1', total: 1 } })
    const event = await pool.query('SELECT tenant_id,body FROM webhooks.events WHERE id=$1', [
      result.eventId,
    ])
    expect(event.rows[0].tenant_id).toBe('tenant-a')
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
    const tenant = webhooks.forTenant({ id: 'tenant-a' })
    const accepted = await tenant.publish({ type: 'transformed', data: 'o1' })
    const event = await pool.query('SELECT body FROM webhooks.events WHERE id=$1', [
      accepted.eventId,
    ])
    expect(JSON.parse(event.rows[0].body).data).toEqual({ id: 'o1' })
    await expect(tenant.publish({ type: 'invalid', data: 'o1' })).rejects.toMatchObject({
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
    const tenant = createWebhooks({
      ...options,
      events: { first: schema, second: z.number() },
    }).forTenant({ id: 'tenant-a' })
    const input = { type: 'first' as const, data: { id: 'o1' }, idempotencyKey: 'original' }
    const pending = tenant.publish(input)
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
    const tenant = createWebhooks(options).forTenant({ id: 'tenant-a' })
    await expect(
      tenant.endpoints.create({ url: 'http://localhost:12345', eventTypes: ['missing'] } as never),
    ).rejects.toThrow(/eventTypes/)
    await expect(tenant.publish({ type: 'missing', data: {} } as never)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    expect((await pool.query('SELECT id FROM webhooks.events')).rows).toHaveLength(0)
  })
})
