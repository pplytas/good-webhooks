import { afterEach, describe, expect, it, vi } from 'vitest'
import { createManagement } from '../src/management/index.js'
import type {
  ManagementOptions,
  ManagementRepository,
  ManagementScope,
  StoredEndpoint,
} from '../src/management/types.js'

function memoryRepository(): ManagementRepository {
  const rows = new Map<string, StoredEndpoint>()
  let sequence = 0
  const key = (scope: ManagementScope, id: string) => JSON.stringify([scope, id])
  return {
    async list(scope) {
      const prefix = JSON.stringify(scope)
      return [...rows.entries()]
        .filter(([id, row]) => id.startsWith(`[${prefix},`) && row.status !== 'deleted')
        .map(([, row]) => structuredClone(row))
    },
    async get(scope, id) {
      return structuredClone(rows.get(key(scope, id)) ?? null)
    },
    async create(scope, value) {
      const row = { ...structuredClone(value), id: `endpoint-${++sequence}` }
      rows.set(key(scope, row.id), row)
      return structuredClone(row)
    },
    async update(scope, id, revision, patch) {
      const row = rows.get(key(scope, id))
      if (!row || row.revision !== revision || row.status === 'deleted') return null
      const updated = { ...row, ...structuredClone(patch), revision: row.revision + 1 }
      rows.set(key(scope, id), updated)
      return structuredClone(updated)
    },
  }
}

function setup(overrides: Partial<ManagementOptions> = {}) {
  const repository = memoryRepository()
  const management = createManagement({
    repository,
    eventTypes: ['order.created', 'order.updated'],
    cipher: {
      async encrypt(value) {
        return `encrypted:${value}`
      },
      async decrypt(value) {
        return value.slice('encrypted:'.length)
      },
    },
    ...overrides,
  })
  return { repository, management }
}

const input = { url: 'https://example.com/webhook', eventTypes: ['order.created'] }
afterEach(() => vi.useRealTimers())

describe('portable endpoint management', () => {
  it('isolates scopes and exposes plaintext secrets only through creation/rotation and trusted resolution', async () => {
    const { management, repository } = setup()
    const scope = { type: 'user', id: 'same' }
    const result = await management.create(scope, input)
    expect(result.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/)
    expect(await management.list({ type: 'organization', id: 'same' })).toEqual([])
    await expect(management.get(null, result.endpoint.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(await management.get(scope, result.endpoint.id)).not.toHaveProperty('encryptedSecret')
    expect(await management.list(scope)).toEqual([result.endpoint])
    expect(await repository.get(scope, result.endpoint.id)).toMatchObject({
      encryptedSecret: `encrypted:${result.secret}`,
    })
    expect(await management.source.resolveEndpoint(scope, result.endpoint.id)).toEqual({
      status: 'active',
      url: input.url,
      secrets: [result.secret],
    })
    expect(await management.source.resolveEndpoint(null, result.endpoint.id)).toEqual({
      status: 'deleted',
    })
  })

  it('snapshots caller-owned scope and subscriptions before asynchronous work', async () => {
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const { management } = setup({
      scopeExists: async () => {
        await waiting
        return true
      },
    })
    const scope = { type: 'user', id: 'original' }
    const subscriptions = ['order.created']
    const creating = management.create(scope, { ...input, eventTypes: subscriptions })
    scope.id = 'changed'
    subscriptions[0] = 'order.updated'
    release()
    const { endpoint } = await creating
    expect(
      await management.source.matchRecipients({ type: 'user', id: 'original' }, 'order.created'),
    ).toEqual([endpoint.id])
    expect(await management.list(scope)).toEqual([])
  })

  it('keeps paused subscriptions, resolves latest state and permanently retires secrets', async () => {
    const { management, repository } = setup()
    const { endpoint } = await management.create(null, input)
    await management.pause(null, endpoint.id)
    expect(await management.source.matchRecipients(null, 'order.created')).toEqual([endpoint.id])
    expect(await management.source.resolveEndpoint(null, endpoint.id)).toEqual({ status: 'paused' })
    await management.update(null, endpoint.id, { url: 'https://example.com/fixed' })
    await management.resume(null, endpoint.id)
    expect(await management.source.resolveEndpoint(null, endpoint.id)).toMatchObject({
      status: 'active',
      url: 'https://example.com/fixed',
    })
    await management.remove(null, endpoint.id)
    expect(await management.source.matchRecipients(null, 'order.created')).toEqual([])
    expect(await repository.get(null, endpoint.id)).toMatchObject({
      status: 'deleted',
      encryptedSecret: '',
      previousEncryptedSecret: null,
    })
    await expect(management.resume(null, endpoint.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    await expect(management.remove(null, endpoint.id)).resolves.toMatchObject({ status: 'deleted' })
  })

  it('retries conflicting patches without losing fields or reviving deletion', async () => {
    const { management } = setup()
    const { endpoint } = await management.create(null, input)
    await Promise.all([
      management.update(null, endpoint.id, { description: 'new description' }),
      management.update(null, endpoint.id, { eventTypes: ['order.updated'] }),
    ])
    expect(await management.get(null, endpoint.id)).toMatchObject({
      description: 'new description',
      eventTypes: ['order.updated'],
    })
    await Promise.allSettled([
      management.remove(null, endpoint.id),
      management.update(null, endpoint.id, { description: 'racing edit' }),
    ])
    expect(await management.get(null, endpoint.id)).toMatchObject({ status: 'deleted' })
  })

  it('guards overlapping rotation, expires the old key, and permits explicit immediate replacement', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-07T00:00:00Z') })
    const { management } = setup()
    const first = await management.create(null, input)
    const rotations = await Promise.allSettled([
      management.rotateSecret(null, first.endpoint.id, { graceMs: 1000 }),
      management.rotateSecret(null, first.endpoint.id, { graceMs: 1000 }),
    ])
    expect(rotations.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(rotations.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const rotation = rotations.find((result) => result.status === 'fulfilled')!
    if (rotation.status !== 'fulfilled') throw new Error('Expected rotation')
    expect(await management.source.resolveEndpoint(null, first.endpoint.id)).toMatchObject({
      secrets: [rotation.value.secret, first.secret],
    })
    vi.advanceTimersByTime(1000)
    expect(await management.source.resolveEndpoint(null, first.endpoint.id)).toMatchObject({
      secrets: [rotation.value.secret],
    })
    const immediate = await management.rotateSecret(null, first.endpoint.id, { graceMs: 0 })
    expect(await management.source.resolveEndpoint(null, first.endpoint.id)).toMatchObject({
      secrets: [immediate.secret],
    })
  })

  it('fails closed for missing owners and propagates owner lookup failures', async () => {
    let exists = true
    let broken = false
    const { management } = setup({
      scopeExists: async () => {
        if (broken) throw new Error('owner storage unavailable')
        return exists
      },
    })
    const scope = { type: 'user', id: 'owner' }
    const { endpoint } = await management.create(scope, input)
    exists = false
    expect(await management.source.resolveEndpoint(scope, endpoint.id)).toEqual({
      status: 'deleted',
    })
    expect(await management.source.matchRecipients(scope, 'order.created')).toEqual([])
    await expect(management.create(scope, input)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    broken = true
    await expect(management.source.resolveEndpoint(scope, endpoint.id)).rejects.toThrow(
      'owner storage unavailable',
    )
    await expect(management.source.matchRecipients(scope, 'order.created')).rejects.toThrow(
      'owner storage unavailable',
    )
    await management.removeScope(scope)
    broken = false
    exists = true
    expect(await management.source.resolveEndpoint(scope, endpoint.id)).toEqual({
      status: 'deleted',
    })
  })

  it('cleans up an insertion that races deletion of its owner', async () => {
    let checks = 0
    const { management, repository } = setup({ scopeExists: async () => ++checks === 1 })
    await expect(management.create(null, input)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await repository.list(null)).toEqual([])
  })

  it('reencrypts current and overlapping keys without changing receiver signing values', async () => {
    const { repository, management } = setup()
    const first = await management.create(null, input)
    const second = await management.rotateSecret(null, first.endpoint.id)
    const migrated = createManagement({
      repository,
      eventTypes: ['order.created'],
      cipher: {
        async encrypt(value) {
          return `new:${value}`
        },
        async decrypt(value) {
          return value.replace(/^(encrypted:|new:)/, '')
        },
      },
    })
    expect(await migrated.reencrypt(null)).toBe(1)
    expect(await repository.get(null, first.endpoint.id)).toMatchObject({
      encryptedSecret: `new:${second.secret}`,
      previousEncryptedSecret: `new:${first.secret}`,
    })
    expect(await migrated.source.resolveEndpoint(null, first.endpoint.id)).toMatchObject({
      secrets: [second.secret, first.secret],
    })
  })

  it('does not restore an old signing key when re-encryption races rotation', async () => {
    const { repository, management } = setup()
    const first = await management.create(null, input)
    const migrated = createManagement({
      repository,
      eventTypes: ['order.created'],
      cipher: {
        async encrypt(value) {
          return `new:${value}`
        },
        async decrypt(value) {
          return value.replace(/^(encrypted:|new:)/, '')
        },
      },
    })
    const [, rotated] = await Promise.all([
      migrated.reencrypt(null),
      migrated.rotateSecret(null, first.endpoint.id),
    ])
    expect(await migrated.source.resolveEndpoint(null, first.endpoint.id)).toMatchObject({
      secrets: [rotated.secret, first.secret],
    })
  })

  it('keeps rotation expiry consistent when re-encryption crosses its deadline', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-07T00:00:00Z') })
    const { repository, management } = setup()
    const first = await management.create(null, input)
    const second = await management.rotateSecret(null, first.endpoint.id, { graceMs: 100 })
    const migrated = createManagement({
      repository,
      eventTypes: ['order.created'],
      cipher: {
        async encrypt(value) {
          vi.advanceTimersByTime(200)
          return `new:${value}`
        },
        async decrypt(value) {
          return value.replace(/^(encrypted:|new:)/, '')
        },
      },
    })
    await migrated.reencrypt(null)
    const stored = (await repository.get(null, first.endpoint.id))!
    expect(stored.previousEncryptedSecret === null).toBe(stored.previousSecretExpiresAt === null)
    expect(await migrated.source.resolveEndpoint(null, first.endpoint.id)).toMatchObject({
      secrets: [second.secret],
    })
    await migrated.reencrypt(null)
    expect(await repository.get(null, first.endpoint.id)).toMatchObject({
      previousEncryptedSecret: null,
      previousSecretExpiresAt: null,
    })
  })

  it.each([
    'http://example.com/',
    'https://127.0.0.1/',
    'https://10.0.0.1/',
    'https://[::1]/',
    'https://168.63.129.16/',
    'https://user:pass@example.com/',
    'https://example.com/#fragment',
    'https://example.com./',
    'https://2130706433/',
    'https://[::ffff:127.0.0.1]/',
  ])('rejects unsafe registration URL %s', async (url) => {
    const { management } = setup()
    await expect(management.create(null, { ...input, url })).rejects.toMatchObject({
      code: 'UNSAFE_URL',
    })
  })

  it('requires configured events and explicit localhost development permission', async () => {
    const { management } = setup({ allowLocalhost: true })
    await expect(
      management.create(null, { ...input, url: 'http://localhost:3000/hooks' }),
    ).resolves.toHaveProperty('secret')
    await expect(
      management.create(null, { ...input, eventTypes: ['unknown'] }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      management.create(null, { ...input, url: 'http://10.0.0.1/' }),
    ).rejects.toMatchObject({ code: 'UNSAFE_URL' })
  })
})
