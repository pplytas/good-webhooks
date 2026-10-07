import { readFile } from 'node:fs/promises'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createPostgresManagement,
  createPostgresManagementRepository,
} from '../src/management/postgres.js'
import { APPLICATION_SCOPE } from '../src/scope.js'
import { closeDatabase, pool } from './db.js'

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
  await pool.query('DROP SCHEMA IF EXISTS webhooks_management CASCADE')
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

  it('enforces the strict limit under concurrent creation and reclaims deleted capacity', async () => {
    const management = create()
    const first = await management.create(null, input)
    await pool.query(
      `INSERT INTO webhooks_management.endpoints(id,scope_key,url,event_types,secret)
      SELECT gen_random_uuid()::text,scope_key,url,event_types,secret
      FROM webhooks_management.endpoints CROSS JOIN generate_series(1,998) WHERE id=$1`,
      [first.endpoint.id],
    )
    const repository = createPostgresManagementRepository(pool)
    const stored = (await repository.get(null, first.endpoint.id))!
    // An insert failure must roll back cleanly and leave the final slot available.
    await expect(repository.create(null, { ...stored, eventTypes: [] })).rejects.toMatchObject({
      code: '23514',
    })
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, () => management.create(null, input)),
    )
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    for (const result of attempts) {
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ code: 'INVALID_STATE' })
    }
    expect(await management.source.matchRecipients(null, 'order.created')).toHaveLength(1000)
    await management.remove(null, first.endpoint.id)
    await management.create(null, input)
    expect(await management.source.matchRecipients(null, 'order.created')).toHaveLength(1000)
    expect(
      (
        await pool.query('SELECT secret FROM webhooks_management.endpoints WHERE id=$1', [
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
      `INSERT INTO webhooks_management.endpoints(id,scope_key,url,event_types,secret)
      SELECT gen_random_uuid()::text,scope_key,url,event_types,secret
      FROM webhooks_management.endpoints CROSS JOIN generate_series(1,1000) WHERE id=$1`,
      [first.endpoint.id],
    )
    await expect(management.source.matchRecipients(null, 'order.created')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM webhooks_management.endpoints WHERE scope_key=$1',
          [APPLICATION_SCOPE],
        )
      ).rows[0]?.count,
    ).toBe(1001)
  })
})
