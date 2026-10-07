import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { betterAuth } from 'better-auth'
import { createAuthClient } from 'better-auth/client'
import { getMigrations } from 'better-auth/db/migration'
import { createAccessControl } from 'better-auth/plugins/access'
import { organization, type OrganizationOptions } from 'better-auth/plugins/organization'
import { defaultStatements, ownerAc } from 'better-auth/plugins/organization/access'
import {
  createBetterAuthManagement,
  goodWebhooks,
  type GoodWebhooksOptions,
} from '../src/better-auth/index.js'
import { goodWebhooksClient } from '../src/better-auth/client.js'
import { createBetterAuthRepository } from '../src/better-auth/store.js'

const eventTypes = ['invoice.created', 'invoice.paid'] as const
const origin = 'http://localhost:3000'
const input = {
  url: 'https://receiver.example/webhook',
  eventTypes: ['invoice.created'] as ['invoice.created'],
}
const databases: DatabaseSync[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
})

async function setup(
  pluginOptions: Partial<GoodWebhooksOptions<typeof eventTypes>> = {},
  organizationOptions: Partial<OrganizationOptions> = {},
  serialIds = false,
) {
  const database = new DatabaseSync(':memory:')
  databases.push(database)
  const ac = createAccessControl({
    ...defaultStatements,
    webhookEndpoint: ['create', 'read', 'update', 'delete'] as const,
  })
  const auth = betterAuth({
    database,
    baseURL: origin,
    secret: 'a-long-random-looking-secret-for-better-auth-plugin-tests',
    emailAndPassword: { enabled: true },
    user: { deleteUser: { enabled: true } },
    session: { cookieCache: { enabled: true } },
    logger: { disabled: true },
    ...(serialIds ? { advanced: { database: { generateId: 'serial' as const } } } : {}),
    plugins: [
      organization({
        ac,
        roles: {
          owner: ac.newRole(ownerAc.statements),
          admin: ac.newRole({}),
          reader: ac.newRole({ webhookEndpoint: ['read'] }),
        },
        ...organizationOptions,
      }),
      goodWebhooks({ eventTypes, ...pluginOptions }),
    ],
  })
  await (await getMigrations(auth.options)).runMigrations()
  const context = await auth.$context
  const management = await createBetterAuthManagement(auth)
  async function user(name = 'Alice') {
    const response = await auth.api.signUpEmail({
      body: {
        name,
        email: `${name.toLowerCase()}@example.com`,
        password: 'correct-horse-battery-staple',
      },
      asResponse: true,
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { user: { id: string } }
    const headers = new Headers({
      origin,
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; '),
    })
    return { id: body.user.id, headers }
  }
  async function call(path: string, body: unknown = {}, headers?: Headers) {
    const requestHeaders = new Headers(headers)
    requestHeaders.set('content-type', 'application/json')
    requestHeaders.set('origin', origin)
    return auth.handler(
      new Request(`${origin}/api/auth/good-webhooks/${path}`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(body),
      }),
    )
  }
  return { auth, context, management, database, user, call }
}

describe('Better Auth endpoint management plugin', () => {
  it('authenticates HTTP and auth.api calls, and restricts personal endpoints to their current owner', async () => {
    const { auth, user, call } = await setup()
    const alice = await user()
    const bob = await user('Bob')
    expect((await call('create', input)).status).toBe(401)
    await expect(auth.api.createWebhookEndpoint({ body: input })).rejects.toMatchObject({
      statusCode: 401,
    })
    const created = await auth.api.createWebhookEndpoint({ headers: alice.headers, body: input })
    expect(created.secret).toMatch(/^whsec_/)
    expect((await call('get', { id: created.endpoint.id }, bob.headers)).status).toBe(404)
    for (const operation of ['get', 'update', 'pause', 'resume', 'remove', 'rotate-secret']) {
      expect(
        (
          await call(
            operation,
            { id: created.endpoint.id, scope: { type: 'user', id: alice.id } },
            bob.headers,
          )
        ).status,
      ).toBe(403)
    }
    expect(
      (await call('list', { scope: { type: 'user', id: alice.id } }, bob.headers)).status,
    ).toBe(403)
  })

  it('exposes signing secrets only on create and rotation, and resolves the same records for a trusted worker', async () => {
    const { auth, user, call, management, database } = await setup()
    const alice = await user()
    const createdResponse = await call('create', input, alice.headers)
    expect(createdResponse.headers.get('cache-control')).toContain('no-store')
    const created = (await createdResponse.json()) as { endpoint: { id: string }; secret: string }
    const scope = { type: 'user', id: alice.id }
    expect(await management.source.matchRecipients(scope, 'invoice.created')).toEqual([
      created.endpoint.id,
    ])
    expect(await management.source.resolveEndpoint(scope, created.endpoint.id)).toEqual({
      status: 'active',
      url: input.url,
      secrets: [created.secret],
    })
    const raw = database.prepare('SELECT encryptedSecret FROM webhookEndpoint').get()!
    expect(raw.encryptedSecret).not.toContain(created.secret)
    const read = await auth.api.getWebhookEndpoint({
      headers: alice.headers,
      body: { id: created.endpoint.id },
    })
    expect(JSON.stringify(read)).not.toContain(created.secret)
    expect(read).not.toHaveProperty('encryptedSecret')
    expect(read).not.toHaveProperty('previousEncryptedSecret')
    const rotated = await auth.api.rotateWebhookEndpointSecret({
      headers: alice.headers,
      body: { id: created.endpoint.id },
    })
    expect(await management.source.resolveEndpoint(scope, created.endpoint.id)).toEqual({
      status: 'active',
      url: input.url,
      secrets: [rotated.secret, created.secret],
    })
    await expect(
      auth.api.rotateWebhookEndpointSecret({
        headers: alice.headers,
        body: { id: created.endpoint.id },
      }),
    ).rejects.toMatchObject({ statusCode: 409 })
    await auth.api.pauseWebhookEndpoint({
      headers: alice.headers,
      body: { id: created.endpoint.id },
    })
    expect(await management.source.matchRecipients(scope, 'invoice.created')).toEqual([
      created.endpoint.id,
    ])
    expect(await management.source.resolveEndpoint(scope, created.endpoint.id)).toEqual({
      status: 'paused',
    })
  })

  it('rejects revoked sessions even when a valid cookie cache remains', async () => {
    const { auth, context, user } = await setup()
    const alice = await user()
    await auth.api.createWebhookEndpoint({ headers: alice.headers, body: input })
    await context.adapter.deleteMany({
      model: 'session',
      where: [{ field: 'userId', value: alice.id }],
    })
    await expect(
      auth.api.listWebhookEndpoints({ headers: alice.headers, body: {} }),
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('uses current organization membership and exact role permissions', async () => {
    const { auth, context, user, call } = await setup()
    const alice = await user()
    const bob = await user('Bob')
    const org = await auth.api.createOrganization({
      headers: alice.headers,
      body: { name: 'Acme', slug: 'acme' },
    })
    const scope = { type: 'organization', id: org!.id }
    const created = await auth.api.createWebhookEndpoint({
      headers: alice.headers,
      body: { ...input, scope },
    })
    const member = await context.adapter.create<{ id: string }>({
      model: 'member',
      data: { organizationId: org!.id, userId: bob.id, role: 'admin', createdAt: new Date() },
    })
    expect((await call('list', { scope }, bob.headers)).status).toBe(403)
    await context.adapter.update({
      model: 'member',
      where: [{ field: 'id', value: member.id }],
      update: { role: 'reader' },
    })
    expect((await call('list', { scope }, bob.headers)).status).toBe(200)
    for (const operation of ['update', 'pause', 'resume', 'remove', 'rotate-secret']) {
      expect((await call(operation, { scope, id: created.endpoint.id }, bob.headers)).status).toBe(
        403,
      )
    }
    expect((await call('create', { ...input, scope }, bob.headers)).status).toBe(403)
    await context.adapter.delete({ model: 'member', where: [{ field: 'id', value: member.id }] })
    expect((await call('list', { scope }, bob.headers)).status).toBe(403)
  })

  it('rejects coerced owner IDs instead of creating alternate scope namespaces', async () => {
    const { auth, context, management, user, call } = await setup({}, {}, true)
    const alice = await user()
    const org = await auth.api.createOrganization({
      headers: alice.headers,
      body: { name: 'Acme', slug: 'acme' },
    })
    expect(org!.id).toBe('1')
    const canonicalScope = { type: 'organization', id: org!.id }
    const canonical = await auth.api.createWebhookEndpoint({
      headers: alice.headers,
      body: { ...input, scope: canonicalScope },
    })
    expect((await call('list', { scope: canonicalScope }, alice.headers)).status).toBe(200)
    const repository = createBetterAuthRepository(context.adapter)
    const { id: _id, ...stored } = (await repository.get(canonicalScope, canonical.endpoint.id))!
    for (const id of ['01', '+1', '1e0']) {
      const aliasScope = { type: 'organization', id }
      expect((await call('create', { ...input, scope: aliasScope }, alice.headers)).status).toBe(
        403,
      )
      expect((await call('list', { scope: aliasScope }, alice.headers)).status).toBe(403)
      await expect(management.create(aliasScope, input)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
      // Even a pre-existing alias record cannot become usable by a trusted sender.
      const aliasEndpoint = await repository.create(aliasScope, stored)
      expect(await management.source.resolveEndpoint(aliasScope, aliasEndpoint.id)).toEqual({
        status: 'deleted',
      })
      expect(await management.source.matchRecipients(aliasScope, 'invoice.created')).toEqual([])
      await expect(management.create({ type: 'user', id }, input)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    }
    expect(await management.source.matchRecipients(canonicalScope, 'invoice.created')).toEqual([
      canonical.endpoint.id,
    ])
  })

  it('honors the configured creator role and rechecks dynamic permissions', async () => {
    const { auth, context, user, call } = await setup(
      {},
      { creatorRole: 'founder', dynamicAccessControl: { enabled: true } },
    )
    const alice = await user()
    const bob = await user('Bob')
    const org = await auth.api.createOrganization({
      headers: alice.headers,
      body: { name: 'Acme', slug: 'acme' },
    })
    const scope = { type: 'organization', id: org!.id }
    await auth.api.createWebhookEndpoint({ headers: alice.headers, body: { ...input, scope } })
    await context.adapter.create({
      model: 'member',
      data: { organizationId: org!.id, userId: bob.id, role: 'operator', createdAt: new Date() },
    })
    const role = await context.adapter.create<{ id: string }>({
      model: 'organizationRole',
      data: {
        organizationId: org!.id,
        role: 'operator',
        permission: JSON.stringify({ webhookEndpoint: ['read'] }),
        createdAt: new Date(),
      },
    })
    expect((await call('list', { scope }, bob.headers)).status).toBe(200)
    await context.adapter.update({
      model: 'organizationRole',
      where: [{ field: 'id', value: role.id }],
      update: { permission: JSON.stringify({ webhookEndpoint: [] }) },
    })
    expect((await call('list', { scope }, bob.headers)).status).toBe(403)
  })

  it('defaults application and custom scopes to denied, and calls the host policy for the exact scope/action', async () => {
    const denied = await setup()
    const alice = await denied.user()
    expect((await denied.call('create', { ...input, scope: null }, alice.headers)).status).toBe(403)
    expect(
      (
        await denied.call(
          'create',
          { ...input, scope: { type: 'project', id: 'p1' } },
          alice.headers,
        )
      ).status,
    ).toBe(403)
    const authorizeScope = vi.fn(
      ({ scope, action }) => scope?.type === 'project' && scope.id === 'p1' && action === 'create',
    )
    const allowed = await setup({ authorizeScope })
    const bob = await allowed.user('Bob')
    expect(
      (
        await allowed.call(
          'create',
          { ...input, scope: { type: 'project', id: 'p1' } },
          bob.headers,
        )
      ).status,
    ).toBe(200)
    expect(authorizeScope).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { type: 'project', id: 'p1' },
        action: 'create',
        user: expect.objectContaining({ id: bob.id }),
      }),
    )
    expect(
      (await allowed.call('list', { scope: { type: 'project', id: 'p1' } }, bob.headers)).status,
    ).toBe(403)
    // A permissive custom policy cannot override another user's ownership.
    expect(
      (
        await allowed.call(
          'create',
          { ...input, scope: { type: 'user', id: 'someone-else' } },
          bob.headers,
        )
      ).status,
    ).toBe(403)
  })

  it('cleans up deleted owners while preserving endpoints owned by their organization', async () => {
    const { auth, user, management, database } = await setup()
    const alice = await user()
    const personal = await auth.api.createWebhookEndpoint({ headers: alice.headers, body: input })
    const org = await auth.api.createOrganization({
      headers: alice.headers,
      body: { name: 'Acme', slug: 'acme' },
    })
    const orgScope = { type: 'organization', id: org!.id }
    const shared = await auth.api.createWebhookEndpoint({
      headers: alice.headers,
      body: { ...input, scope: orgScope },
    })
    await auth.api.deleteUser({ headers: alice.headers, body: {} })
    expect(
      await management.source.resolveEndpoint({ type: 'user', id: alice.id }, personal.endpoint.id),
    ).toEqual({ status: 'deleted' })
    expect(
      database.prepare('SELECT status FROM webhookEndpoint WHERE id = ?').get(personal.endpoint.id)
        ?.status,
    ).toBe('deleted')
    expect((await management.source.resolveEndpoint(orgScope, shared.endpoint.id)).status).toBe(
      'active',
    )
  })

  it('deletes organization endpoints through the BA lifecycle hook', async () => {
    const { auth, user, management, database } = await setup()
    const alice = await user()
    const org = await auth.api.createOrganization({
      headers: alice.headers,
      body: { name: 'Acme', slug: 'acme' },
    })
    const scope = { type: 'organization', id: org!.id }
    const shared = await auth.api.createWebhookEndpoint({
      headers: alice.headers,
      body: { ...input, scope },
    })
    await auth.api.deleteOrganization({ headers: alice.headers, body: { organizationId: org!.id } })
    expect(
      database.prepare('SELECT status FROM webhookEndpoint WHERE id = ?').get(shared.endpoint.id)
        ?.status,
    ).toBe('deleted')
    expect(await management.source.matchRecipients(scope, 'invoice.created')).toEqual([])
  })

  it('treats missed cleanup as missing ownership and propagates database failures', async () => {
    const { auth, context, user, management } = await setup()
    const alice = await user()
    const created = await auth.api.createWebhookEndpoint({ headers: alice.headers, body: input })
    const scope = { type: 'user', id: alice.id }
    const spy = vi
      .spyOn(context.adapter, 'findOne')
      .mockRejectedValueOnce(new Error('database unavailable'))
    await expect(management.source.resolveEndpoint(scope, created.endpoint.id)).rejects.toThrow(
      'database unavailable',
    )
    spy.mockRestore()
    await context.adapter.delete({ model: 'user', where: [{ field: 'id', value: alice.id }] })
    expect(await management.source.resolveEndpoint(scope, created.endpoint.id)).toEqual({
      status: 'deleted',
    })
    expect(await management.source.matchRecipients(scope, 'invoice.created')).toEqual([])
  })

  it('preserves JSON strings through the native BA client', async () => {
    const { auth, user } = await setup()
    const alice = await user()
    const client = createAuthClient({
      baseURL: origin,
      plugins: [goodWebhooksClient({ eventTypes })],
      fetchOptions: {
        headers: alice.headers,
        customFetchImpl: (input, init) => auth.handler(new Request(input, init)),
      },
    })
    const description = '2026-10-07T12:00:00.000Z'
    const result = await client.goodWebhooks.create({ ...input, description })
    expect(result.error).toBeNull()
    expect(result.data?.endpoint.description).toBe(description)
    expect(typeof result.data?.endpoint.createdAt).toBe('string')
    const list = await client.goodWebhooks.list({})
    expect(list.data?.[0]?.description).toBe(description)
    // The override is scoped: normal BA session timestamps keep their native Date type.
    const session = await client.getSession()
    expect(session.data?.user.createdAt).toBeInstanceOf(Date)
  })

  it('initializes an independent worker provider and rewrites storage encryption without rotating signing secrets', async () => {
    const { auth, user, database } = await setup()
    const alice = await user()
    const created = await auth.api.createWebhookEndpoint({ headers: alice.headers, body: input })
    const rotated = await auth.api.rotateWebhookEndpointSecret({
      headers: alice.headers,
      body: { id: created.endpoint.id },
    })
    const scope = { type: 'user', id: alice.id }
    const workerAuth = betterAuth({
      ...auth.options,
      secrets: [
        { version: 2, value: 'a-new-storage-encryption-key-for-the-worker-test' },
        { version: 0, value: auth.options.secret },
      ],
    })
    const worker = await createBetterAuthManagement(workerAuth)
    const before = await worker.source.resolveEndpoint(scope, created.endpoint.id)
    expect(before).toEqual({
      status: 'active',
      url: input.url,
      secrets: [rotated.secret, created.secret],
    })
    expect(await worker.reencrypt(scope)).toBe(1)
    const raw = database
      .prepare('SELECT encryptedSecret, previousEncryptedSecret FROM webhookEndpoint')
      .get()!
    expect(raw.encryptedSecret).toMatch(/^\$ba\$2\$/)
    expect(raw.previousEncryptedSecret).toMatch(/^\$ba\$2\$/)
    const retiredAuth = betterAuth({
      ...auth.options,
      secrets: [{ version: 2, value: 'a-new-storage-encryption-key-for-the-worker-test' }],
    })
    expect(
      await (
        await createBetterAuthManagement(retiredAuth)
      ).source.resolveEndpoint(scope, created.endpoint.id),
    ).toEqual(before)
  })
})
