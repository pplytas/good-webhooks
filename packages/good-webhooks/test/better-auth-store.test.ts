import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { betterAuth, type DBAdapter } from 'better-auth'
import { createBetterAuthManagementSchema } from '../src/better-auth/schema.js'
import { createBetterAuthRepository } from '../src/better-auth/store.js'
import { scopeKey } from '../src/scope.js'
import type { StoredEndpoint } from '../src/management/types.js'

const scope = { type: 'user', id: 'owner' }
const databases: DatabaseSync[] = []
const data = (): Omit<StoredEndpoint, 'id'> => ({
  url: 'https://example.com/hook',
  description: null,
  eventTypes: ['invoice.paid'],
  status: 'active',
  revision: 0,
  encryptedSecret: 'encrypted-value',
  previousEncryptedSecret: null,
  previousSecretExpiresAt: null,
  encryptedHeaders: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-01T00:00:00Z'),
})

async function fixture(ids?: 'serial' | 'uuid') {
  const database = new DatabaseSync(':memory:')
  databases.push(database)
  const auth = betterAuth({
    database,
    secret: 'test-only-secret-with-more-than-thirty-two-characters',
    baseURL: 'https://auth.example.com',
    advanced: { database: { validateSchema: false, ...(ids ? { generateId: ids } : {}) } },
    plugins: [
      {
        id: 'webhooks-storage-test',
        schema: createBetterAuthManagementSchema({
          modelName: 'custom_endpoint',
          fields: {
            allocationKey: 'allocation_key',
            eventTypes: 'event_types',
            encryptedSecret: 'secret_ciphertext',
          },
        }),
      },
    ],
  })
  const context = await auth.$context
  await context.runMigrations()
  return {
    database,
    adapter: context.adapter,
    repository: createBetterAuthRepository(context.adapter),
  }
}

function key(slot: number): string {
  return `${createHash('sha256').update(scopeKey(scope)).digest('hex')}:${slot}`
}

async function seed(adapter: Pick<DBAdapter, 'create'>, count: number) {
  for (let slot = 0; slot < count; slot++) {
    await adapter.create({
      model: 'webhookEndpoint',
      data: {
        ...data(),
        scopeKey: scopeKey(scope),
        allocationKey: key(slot),
        creationToken: `seed:${slot}`,
      },
    })
  }
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe('Better Auth management repository with real SQLite adapter and generated schema', () => {
  for (const ids of [undefined, 'serial', 'uuid'] as const) {
    it(`round trips arrays and private fields with ${ids ?? 'default'} IDs and custom database names`, async () => {
      const { repository } = await fixture(ids)
      const created = await repository.create(scope, data(), { limit: 1000 })
      expect(typeof created.id).toBe('string')
      expect(created.eventTypes).toEqual(['invoice.paid'])
      expect(created.encryptedSecret).toBe('encrypted-value')
      expect(created.encryptedHeaders).toBeNull()
      expect(await repository.get(scope, created.id)).toEqual(created)
      expect(await repository.get({ type: 'user', id: 'OWNER' }, created.id)).toBeNull()
      expect(await repository.list(null)).toEqual([])
      expect(await repository.list(scope)).toEqual([created])
      const paused = await repository.update(scope, created.id, created.revision, {
        status: 'paused',
        pauseReason: 'failing',
      })
      expect(paused).toMatchObject({ status: 'paused', pauseReason: 'failing' })
      expect(await repository.get(scope, created.id)).toEqual(paused)
    })
  }

  it('admits at most 1000 records under concurrent creation and releases capacity atomically', async () => {
    const { adapter, repository } = await fixture()
    await seed(adapter, 995)
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => repository.create(scope, data(), { limit: 1000 })),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(15)
    const rows = await repository.list(scope)
    expect(rows).toHaveLength(1000)
    const first = rows[0]!
    const deleted = await repository.update(scope, first.id, first.revision, { status: 'deleted' })
    expect(deleted?.status).toBe('deleted')
    const replacement = await repository.create(scope, data(), { limit: 1000 })
    expect(replacement.id).not.toBe(first.id)
    expect(await repository.list(scope)).toHaveLength(1000)
    expect((await repository.get(scope, first.id))?.status).toBe('deleted')
    await expect(
      repository.update(scope, first.id, deleted!.revision, { status: 'active' }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })

  it('admits at most a lower limit under concurrent creation and counts endpoints in any slot', async () => {
    const { repository } = await fixture()
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => repository.create(scope, data(), { limit: 3 })),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3)
    for (const result of results)
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ code: 'ENDPOINT_LIMIT' })

    // An endpoint created under the default limit can hold any slot and still counts.
    const other = await fixture()
    await other.adapter.create({
      model: 'webhookEndpoint',
      data: { ...data(), scopeKey: scopeKey(scope), allocationKey: key(900), creationToken: 'old' },
    })
    const concurrent = await Promise.allSettled(
      Array.from({ length: 10 }, () => other.repository.create(scope, data(), { limit: 3 })),
    )
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(2)
    expect(await other.repository.list(scope)).toHaveLength(3)
    await expect(other.repository.create(scope, data(), { limit: 3 })).rejects.toMatchObject({
      code: 'ENDPOINT_LIMIT',
    })
    await expect(other.repository.create(scope, data(), { limit: 1001 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
  })

  it('has one winner for concurrent revision-guarded writes including rotation fields', async () => {
    const { repository } = await fixture()
    const original = await repository.create(scope, data(), { limit: 1000 })
    const expiresAt = new Date('2026-10-08T00:00:00Z')
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        repository.update(scope, original.id, 0, {
          encryptedSecret: `new-${index}`,
          previousEncryptedSecret: original.encryptedSecret,
          previousSecretExpiresAt: expiresAt,
        }),
      ),
    )
    const winners = results.filter((result) => result !== null)
    expect(winners).toHaveLength(1)
    expect(winners[0]).toMatchObject({
      revision: 1,
      previousEncryptedSecret: 'encrypted-value',
      previousSecretExpiresAt: expiresAt,
    })
    expect(await repository.get(scope, original.id)).toEqual(winners[0])
  })

  it('stores, returns, and keeps encrypted endpoint headers across updates', async () => {
    const { adapter, repository, database } = await fixture()
    await adapter.create({
      model: 'webhookEndpoint',
      data: {
        ...data(),
        scopeKey: scopeKey(scope),
        allocationKey: key(0),
        creationToken: 'headers',
        encryptedHeaders: 'x',
      },
    })
    const [stored] = await repository.list(scope)
    expect(stored?.encryptedHeaders).toBe('x')
    const paused = await repository.update(scope, stored!.id, stored!.revision, {
      status: 'paused',
    })
    expect(paused?.encryptedHeaders).toBe('x')
    expect(database.prepare('SELECT encryptedHeaders FROM custom_endpoint').get()).toEqual({
      encryptedHeaders: 'x',
    })
    const changed = await repository.update(scope, stored!.id, paused!.revision, {
      encryptedHeaders: 'blob',
    })
    expect(changed?.encryptedHeaders).toBe('blob')
    expect((await repository.get(scope, stored!.id))?.encryptedHeaders).toBe('blob')
    expect((await repository.list(scope))[0]?.encryptedHeaders).toBe('blob')
    const cleared = await repository.update(scope, stored!.id, changed!.revision, {
      encryptedHeaders: null,
    })
    expect(cleared?.encryptedHeaders).toBeNull()
    const created = await repository.create(
      scope,
      { ...data(), encryptedHeaders: 'new' },
      { limit: 1000 },
    )
    expect(created.encryptedHeaders).toBe('new')
    expect((await repository.get(scope, created.id))?.encryptedHeaders).toBe('new')
    const corrupt = createBetterAuthRepository({
      ...adapter,
      findOne: async <T>(input: Parameters<DBAdapter['findOne']>[0]) =>
        ({ ...(await adapter.findOne<Record<string, unknown>>(input)), encryptedHeaders: 5 }) as T,
    })
    await expect(corrupt.get(scope, stored!.id)).rejects.toMatchObject({
      code: 'SCHEMA_MISMATCH',
    })
  })

  it('preserves all 100 maximum-length subscriptions in bounded physical array fields', async () => {
    const { repository, database } = await fixture()
    const eventTypes = Array.from(
      { length: 100 },
      (_, index) => `${'x'.repeat(116)}${String(index).padStart(4, '0')}`,
    )
    const created = await repository.create(scope, { ...data(), eventTypes }, { limit: 1000 })
    expect(created.eventTypes).toEqual(eventTypes)
    const stored = database
      .prepare('SELECT event_types, additionalEventTypes FROM custom_endpoint')
      .get()!
    expect(String(stored.event_types).length).toBeLessThan(8000)
    expect(String(stored.additionalEventTypes).length).toBeLessThan(8000)
    const changed = await repository.update(scope, created.id, created.revision, {
      eventTypes: ['invoice.failed'],
    })
    expect(changed!.eventTypes).toEqual(['invoice.failed'])
    expect((await repository.get(scope, created.id))!.eventTypes).toEqual(['invoice.failed'])
  })

  it('does not retry an ambiguous committed insertion into another slot', async () => {
    const { adapter, repository } = await fixture()
    let inserts = 0
    const failing = createBetterAuthRepository({
      ...adapter,
      create: async (input) => {
        inserts++
        await adapter.create(input)
        throw new Error('Connection lost after commit')
      },
    })
    await expect(failing.create(scope, data(), { limit: 1000 })).rejects.toThrow(
      'Connection lost after commit',
    )
    expect(inserts).toBe(1)
    expect(await repository.list(scope)).toHaveLength(1)
  })

  it('retries only explicitly rolled-back writes with the same allocation and mutation', async () => {
    const { adapter, repository } = await fixture()
    const insertions: unknown[] = []
    const mutations: unknown[] = []
    const retrying = createBetterAuthRepository({
      ...adapter,
      create: async (input) => {
        insertions.push(input.data)
        if (insertions.length === 1)
          throw Object.assign(new Error('Deadlock victim'), { number: 1205 })
        return adapter.create(input)
      },
      incrementOne: async (input) => {
        mutations.push(input)
        if (mutations.length === 1)
          throw Object.assign(new Error('Serialization rollback'), { code: '40001' })
        return adapter.incrementOne(input)
      },
    })
    const created = await retrying.create(scope, data(), { limit: 1000 })
    expect(insertions).toHaveLength(2)
    expect(insertions[0]).toEqual(insertions[1])
    expect(await repository.list(scope)).toHaveLength(1)
    expect(
      (await retrying.update(scope, created.id, created.revision, { status: 'deleted' }))?.revision,
    ).toBe(1)
    expect(mutations).toHaveLength(2)
    expect(mutations[0]).toEqual(mutations[1])
  })

  it('does not retry an ambiguous committed conditional mutation', async () => {
    const { adapter, repository } = await fixture()
    const created = await repository.create(scope, data(), { limit: 1000 })
    let writes = 0
    const failing = createBetterAuthRepository({
      ...adapter,
      incrementOne: async (input) => {
        writes++
        await adapter.incrementOne(input)
        throw new Error('Connection lost after commit')
      },
    })
    await expect(
      failing.update(scope, created.id, created.revision, { status: 'paused' }),
    ).rejects.toThrow('Connection lost after commit')
    expect(writes).toBe(1)
    expect(await repository.get(scope, created.id)).toMatchObject({ status: 'paused', revision: 1 })
  })

  it('leaves no reservation behind when insertion fails before writing', async () => {
    const { adapter, repository } = await fixture()
    const failing = createBetterAuthRepository({
      ...adapter,
      create: async () => {
        throw new Error('Unavailable')
      },
    })
    await expect(failing.create(scope, data(), { limit: 1000 })).rejects.toThrow('Unavailable')
    expect(await repository.list(scope)).toEqual([])
    await expect(repository.create(scope, data(), { limit: 1000 })).resolves.toMatchObject({
      status: 'active',
    })
  })

  it('enumerates unchanged records completely when earlier slots disappear between batches', async () => {
    const { adapter, repository } = await fixture()
    await seed(adapter, 120)
    const original = await repository.list(scope)
    let reads = 0
    const changing = createBetterAuthRepository({
      ...adapter,
      findMany: async <T>(input: Parameters<DBAdapter['findMany']>[0]): Promise<T[]> => {
        const rows = await adapter.findMany<T>(input)
        if (++reads === 1) {
          const first = await adapter.findOne<StoredEndpoint>({
            model: 'webhookEndpoint',
            where: [{ field: 'allocationKey', value: key(0) }],
          })
          await repository.update(scope, first!.id, first!.revision, { status: 'deleted' })
        }
        return rows
      },
    })
    const found = await changing.list(scope)
    expect(new Set(found.map((row) => row.id))).toEqual(new Set(original.map((row) => row.id)))
    expect(reads).toBe(20)
  })

  it('rejects lookup failure and missing uniqueness instead of returning a partial list', async () => {
    const { adapter, repository, database } = await fixture()
    await seed(adapter, 60)
    let reads = 0
    const failing = createBetterAuthRepository({
      ...adapter,
      findMany: async <T>(input: Parameters<DBAdapter['findMany']>[0]): Promise<T[]> => {
        if (++reads === 2) throw new Error('Lookup unavailable')
        return adapter.findMany<T>(input)
      },
    })
    await expect(failing.list(scope)).rejects.toThrow('Lookup unavailable')
    database.exec('DROP INDEX custom_endpoint_allocation_key_uidx')
    await adapter.create({
      model: 'webhookEndpoint',
      data: {
        ...data(),
        scopeKey: scopeKey(scope),
        allocationKey: key(0),
        creationToken: 'corrupt',
      },
    })
    await expect(repository.list(scope)).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' })
  })
})
