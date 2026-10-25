import { readFile } from 'node:fs/promises'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createPostgresManagement,
  createPostgresManagementRepository,
} from '../src/management/postgres.js'
import { APPLICATION_SCOPE } from '../src/scope.js'
import { dropWebhookTables, closeDatabase, pool } from './db.js'

const encryptionKey = new Uint8Array(32).fill(7)
const create = (key = encryptionKey, decryptionKeys: Uint8Array[] = []) =>
  createPostgresManagement({
    database: pool,
    eventTypes: ['order.created', 'order.updated'],
    encryptionKey: key,
    decryptionKeys,
    allowLocalhost: true,
  })
const input = { url: 'http://127.0.0.1:9999/webhooks', eventTypes: ['order.created'] }

beforeEach(async () => {
  await dropWebhookTables(pool)
  await pool.query(await readFile(new URL('../migrations/management.sql', import.meta.url), 'utf8'))
})
afterAll(closeDatabase)

describe('standalone PostgreSQL management', () => {
  it('requires only the management schema and keeps scope identities separate', async () => {
    const management = create()
    await expect(management.check()).resolves.toBeUndefined()
    const app = await management.create(null, input)
    const user = await management.create({ type: 'user', id: 'owner' }, input)
    expect(await management.source.matchRecipients(null, 'order.created')).toEqual([
      app.endpoint.id,
    ])
    expect(
      await management.source.matchRecipients({ type: 'user', id: 'owner' }, 'order.created'),
    ).toEqual([user.endpoint.id])
    expect(await management.list({ type: 'organization', id: 'owner' })).toEqual([])
    await management.removeScope({ type: 'user', id: 'owner' })
    expect(
      await management.source.resolveEndpoint({ type: 'user', id: 'owner' }, user.endpoint.id),
    ).toEqual({ status: 'deleted' })
  })

  it('stores the pause reason and pauses for the worker with a revision guard', async () => {
    const management = create()
    const { endpoint } = await management.create(null, input)
    expect((await management.pause(null, endpoint.id)).pauseReason).toBe('owner')
    const resumed = await management.resume(null, endpoint.id)
    expect(resumed.pauseReason).toBeNull()
    const resolution = await management.source.resolveEndpoint(null, endpoint.id)
    expect(resolution).toMatchObject({ status: 'active', revision: '2' })
    expect(
      await management.source.pause!(null, endpoint.id, { reason: 'failing', revision: '1' }),
    ).toBe(false)
    expect(
      await management.source.pause!(null, endpoint.id, { reason: 'failing', revision: '2' }),
    ).toBe(true)
    expect(await management.get(null, endpoint.id)).toMatchObject({
      status: 'paused',
      pauseReason: 'failing',
    })
    await expect(
      pool.query("UPDATE public.webhook_endpoints SET pause_reason='other'"),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('round trips encrypted endpoint headers and keeps them out of client results', async () => {
    const management = create()
    const repository = createPostgresManagementRepository(pool)
    const { endpoint } = await management.create(null, input)
    const stored = (await repository.get(null, endpoint.id))!
    expect(stored.encryptedHeaders).toBeNull()
    const updated = await repository.update(null, endpoint.id, stored.revision, {
      encryptedHeaders: 'blob',
    })
    expect(updated?.encryptedHeaders).toBe('blob')
    expect((await repository.get(null, endpoint.id))?.encryptedHeaders).toBe('blob')
    expect((await repository.list(null))[0]?.encryptedHeaders).toBe('blob')
    // Management operations leave the blob alone and never return it.
    expect(await management.pause(null, endpoint.id)).not.toHaveProperty('encryptedHeaders')
    await management.rotateSecret(null, endpoint.id, { graceMs: 0 })
    expect(await management.reencrypt(null)).toBe(1)
    expect((await repository.get(null, endpoint.id))?.encryptedHeaders).toBe('blob')
    expect(await management.get(null, endpoint.id)).not.toHaveProperty('encryptedHeaders')
    const { id: _id, ...record } = stored
    const copy = await repository.create(
      null,
      { ...record, encryptedHeaders: 'other' },
      { limit: 1000 },
    )
    expect((await repository.get(null, copy.id))?.encryptedHeaders).toBe('other')
  })

  it('applies a per-scope endpoint limit under concurrent creation', async () => {
    const user = { type: 'user', id: 'owner' }
    const management = createPostgresManagement({
      database: pool,
      eventTypes: ['order.created'],
      encryptionKey,
      allowLocalhost: true,
      maxEndpoints: async (scope) => (scope === null ? 5 : 2),
    })
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () => management.create(user, input)),
    )
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(2)
    for (const result of attempts)
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({
          code: 'ENDPOINT_LIMIT',
          message: 'This scope already has its limit of 2 endpoints.',
        })
    await Promise.all(Array.from({ length: 5 }, () => management.create(null, input)))
    const [first] = await management.list(user)
    await management.remove(user, first!.id)
    await expect(management.create(user, input)).resolves.toBeDefined()

    const invalid = createPostgresManagement({
      database: pool,
      eventTypes: ['order.created'],
      encryptionKey,
      allowLocalhost: true,
      maxEndpoints: () => 1001,
    })
    await expect(invalid.create(user, input)).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
  })

  it('enforces the strict limit under concurrent creation and reclaims deleted capacity', async () => {
    const management = create()
    const first = await management.create(null, input)
    await pool.query(
      `INSERT INTO public.webhook_endpoints(id,scope_key,url,event_types,secret)
      SELECT gen_random_uuid()::text,scope_key,url,event_types,secret
      FROM public.webhook_endpoints CROSS JOIN generate_series(1,998) WHERE id=$1`,
      [first.endpoint.id],
    )
    const repository = createPostgresManagementRepository(pool)
    const stored = (await repository.get(null, first.endpoint.id))!
    // An invalid limit is an input error, not a full scope.
    for (const limit of [-1, 1001, Number.NaN])
      await expect(repository.create(null, stored, { limit })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      })
    // A caller still passing the pre-0.5.0 bare limit gets an input error, not an insert.
    await expect(repository.create(null, stored, 1000 as never)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    // An insert failure must roll back cleanly and leave the final slot available.
    await expect(
      repository.create(null, { ...stored, eventTypes: [] }, { limit: 1000 }),
    ).rejects.toMatchObject({
      code: '23514',
    })
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, () => management.create(null, input)),
    )
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    for (const result of attempts) {
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ code: 'ENDPOINT_LIMIT' })
    }
    expect(await management.source.matchRecipients(null, 'order.created')).toHaveLength(1000)
    await management.remove(null, first.endpoint.id)
    await management.create(null, input)
    expect(await management.source.matchRecipients(null, 'order.created')).toHaveLength(1000)
    expect(
      (
        await pool.query('SELECT secret FROM public.webhook_endpoints WHERE id=$1', [
          first.endpoint.id,
        ])
      ).rows[0]?.secret,
    ).toBe('')
  })

  it('preserves concurrent patches and admits only one overlapping rotation', async () => {
    const management = create()
    const { endpoint } = await management.create(null, input)
    await Promise.all([
      management.update(null, endpoint.id, { description: 'changed' }),
      management.update(null, endpoint.id, { eventTypes: ['order.updated'] }),
    ])
    expect(await management.get(null, endpoint.id)).toMatchObject({
      description: 'changed',
      eventTypes: ['order.updated'],
    })
    const rotations = await Promise.allSettled([
      management.rotateSecret(null, endpoint.id),
      management.rotateSecret(null, endpoint.id),
    ])
    expect(rotations.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(rotations.filter((result) => result.status === 'rejected')).toHaveLength(1)
    await Promise.allSettled([
      management.remove(null, endpoint.id),
      management.resume(null, endpoint.id),
    ])
    expect(await management.get(null, endpoint.id)).toMatchObject({ status: 'deleted' })
  })

  it('rewrites both signing secrets under a replacement storage key', async () => {
    const initial = create()
    const first = await initial.create(null, input)
    const second = await initial.rotateSecret(null, first.endpoint.id)
    const replacementKey = new Uint8Array(32).fill(8)
    const migration = create(replacementKey, [encryptionKey])
    expect(await migration.reencrypt(null)).toBe(1)
    expect(
      await create(replacementKey).source.resolveEndpoint(null, first.endpoint.id),
    ).toMatchObject({ secrets: [second.secret, first.secret] })
    await expect(initial.source.resolveEndpoint(null, first.endpoint.id)).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    })
  })

  it('rejects incomplete enumeration if external writes violate the bound', async () => {
    const management = create()
    const first = await management.create(null, input)
    await pool.query(
      `INSERT INTO public.webhook_endpoints(id,scope_key,url,event_types,secret)
      SELECT gen_random_uuid()::text,scope_key,url,event_types,secret
      FROM public.webhook_endpoints CROSS JOIN generate_series(1,1000) WHERE id=$1`,
      [first.endpoint.id],
    )
    await expect(management.source.matchRecipients(null, 'order.created')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM public.webhook_endpoints WHERE scope_key=$1',
          [APPLICATION_SCOPE],
        )
      ).rows[0]?.count,
    ).toBe(1001)
  })
})
