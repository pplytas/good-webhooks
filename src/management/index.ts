import { WebhookError } from '../errors.js'
import { scopeKey } from '../scope.js'
import { parseEndpointUrl } from './url.js'
import type {
  EndpointManagement,
  EndpointSource,
  ManagedEndpoint,
  ManagementOptions,
  ManagementScope,
  StoredEndpoint,
  StoredEndpointPatch,
} from './types.js'

export type * from './types.js'

const MAX_ROTATION_GRACE_MS = 86_400_000
const MAX_UPDATE_RETRIES = 32

function invalid(message: string): never {
  throw new WebhookError('INVALID_INPUT', message)
}

function inputObject(value: unknown, name: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid(`${name} must be an object.`)
}

function snapshotScope(scope: ManagementScope): ManagementScope {
  if (scope === null) return null
  // Validate and copy before the first await, including mutable caller objects.
  const copy = { type: scope?.type, id: scope?.id }
  scopeKey(copy)
  return Object.freeze(copy)
}

function endpointId(id: string): void {
  if (typeof id !== 'string' || !id.trim() || id.length > 255 || id.includes('\0'))
    invalid('Endpoint id must contain 1–255 characters and no null bytes.')
}

function description(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > 2000 || value.includes('\0'))
    invalid('Description must contain at most 2000 characters and no null bytes.')
  return value
}

function dto(row: StoredEndpoint): ManagedEndpoint {
  return Object.freeze({
    id: row.id,
    url: row.url,
    description: row.description,
    eventTypes: Object.freeze([...row.eventTypes]) as string[],
    status: row.status,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  })
}

function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `whsec_${btoa(String.fromCharCode(...bytes))}`
}

/** Shared endpoint lifecycle. Trusted callers must authorize their own scope selection. */
export function createManagement(options: ManagementOptions): EndpointManagement {
  if (
    !options ||
    !Array.isArray(options.eventTypes) ||
    options.eventTypes.length === 0 ||
    options.eventTypes.some(
      (name) => typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(name),
    ) ||
    typeof options.repository?.list !== 'function' ||
    typeof options.repository.get !== 'function' ||
    typeof options.repository.create !== 'function' ||
    typeof options.repository.update !== 'function' ||
    typeof options.cipher?.encrypt !== 'function' ||
    typeof options.cipher.decrypt !== 'function' ||
    (options.allowLocalhost !== undefined && typeof options.allowLocalhost !== 'boolean') ||
    (options.scopeExists !== undefined && typeof options.scopeExists !== 'function') ||
    (options.validateUrl !== undefined && typeof options.validateUrl !== 'function')
  )
    throw new WebhookError(
      'INVALID_CONFIG',
      'Supply event names, a management repository, and a secret cipher.',
    )
  const { repository, cipher, scopeExists } = options
  const validateUrl = options.validateUrl
  const allowLocalhost = options.allowLocalhost ?? false
  const allowed = new Set(options.eventTypes)

  function eventTypes(types: readonly string[]): string[] {
    if (
      !Array.isArray(types) ||
      types.length < 1 ||
      types.length > 100 ||
      types.some((name) => !allowed.has(name))
    )
      invalid('An endpoint must subscribe to 1–100 configured event names.')
    return [...new Set(types)]
  }

  async function safeUrl(url: string): Promise<void> {
    parseEndpointUrl(url, allowLocalhost)
    await validateUrl?.(url)
  }

  async function ownerExists(scope: ManagementScope): Promise<boolean> {
    return scopeExists ? scopeExists(scope) : true
  }

  async function requireOwner(scope: ManagementScope): Promise<void> {
    if (!(await ownerExists(scope)))
      throw new WebhookError('NOT_FOUND', 'Endpoint owner no longer exists.')
  }

  async function read(scope: ManagementScope, id: string): Promise<StoredEndpoint> {
    const current = await repository.get(scope, id)
    if (!current) throw new WebhookError('NOT_FOUND', 'Endpoint not found in this scope.')
    return current
  }

  async function edit(
    scope: ManagementScope,
    id: string,
    patch: (current: StoredEndpoint) => StoredEndpointPatch | Promise<StoredEndpointPatch>,
    allowDeleted = false,
  ): Promise<StoredEndpoint> {
    for (let attempt = 0; attempt < MAX_UPDATE_RETRIES; attempt++) {
      const current = await read(scope, id)
      if (current.status === 'deleted') {
        if (allowDeleted) return current
        throw new WebhookError('INVALID_STATE', 'Deleted endpoints cannot be modified.')
      }
      const change = await patch(current)
      const updated = await repository.update(scope, id, current.revision, {
        ...change,
        updatedAt: new Date(),
      })
      if (updated) return updated
    }
    throw new WebhookError(
      'INVALID_STATE',
      'The endpoint changed too frequently. Retry the operation.',
    )
  }

  async function remove(scope: ManagementScope, id: string): Promise<ManagedEndpoint> {
    return dto(
      await edit(
        scope,
        id,
        () => ({
          status: 'deleted',
          encryptedSecret: '',
          previousEncryptedSecret: null,
          previousSecretExpiresAt: null,
        }),
        true,
      ),
    )
  }

  return {
    source: Object.freeze<EndpointSource>({
      async matchRecipients(inputScope, eventType) {
        const scope = snapshotScope(inputScope)
        if (typeof eventType !== 'string' || !allowed.has(eventType)) invalid('Unknown event name.')
        if (!(await ownerExists(scope))) return []
        const endpoints = await repository.list(scope)
        return endpoints
          .filter((row) => row.status !== 'deleted' && row.eventTypes.includes(eventType))
          .map((row) => row.id)
      },
      async resolveEndpoint(inputScope, id) {
        const scope = snapshotScope(inputScope)
        endpointId(id)
        if (!(await ownerExists(scope))) return { status: 'deleted' }
        const row = await repository.get(scope, id)
        if (!row || row.status === 'deleted') return { status: 'deleted' }
        if (row.status === 'paused') return { status: 'paused' }
        const secrets = [await cipher.decrypt(row.encryptedSecret)]
        if (
          row.previousEncryptedSecret &&
          row.previousSecretExpiresAt &&
          row.previousSecretExpiresAt.getTime() > Date.now()
        )
          secrets.push(await cipher.decrypt(row.previousEncryptedSecret))
        return { status: 'active', url: row.url, secrets }
      },
    }),
    async create(inputScope, input) {
      const scope = snapshotScope(inputScope)
      inputObject(input, 'Endpoint input')
      const url = input.url
      const subscriptions = eventTypes(input.eventTypes)
      const desc = description(input.description)
      await requireOwner(scope)
      await safeUrl(url)
      const secret = generateSecret()
      const encryptedSecret = await cipher.encrypt(secret)
      const now = new Date()
      const row = await repository.create(scope, {
        url,
        description: desc,
        eventTypes: subscriptions,
        status: 'active',
        encryptedSecret,
        previousEncryptedSecret: null,
        previousSecretExpiresAt: null,
        revision: 0,
        createdAt: now,
        updatedAt: now,
      })
      // A concurrent owner deletion can finish before this insert. Do not leave a live orphan.
      if (!(await ownerExists(scope))) {
        await remove(scope, row.id)
        throw new WebhookError('NOT_FOUND', 'Endpoint owner no longer exists.')
      }
      return { endpoint: dto(row), secret }
    },
    async list(inputScope) {
      const scope = snapshotScope(inputScope)
      await requireOwner(scope)
      return (await repository.list(scope)).filter((row) => row.status !== 'deleted').map(dto)
    },
    async get(inputScope, id) {
      const scope = snapshotScope(inputScope)
      endpointId(id)
      await requireOwner(scope)
      return dto(await read(scope, id))
    },
    async update(inputScope, id, input) {
      const scope = snapshotScope(inputScope)
      endpointId(id)
      inputObject(input, 'Endpoint patch')
      const patch: StoredEndpointPatch = {}
      if (input.url !== undefined) patch.url = input.url
      if (input.description !== undefined) patch.description = description(input.description)
      if (input.eventTypes !== undefined) patch.eventTypes = eventTypes(input.eventTypes)
      await requireOwner(scope)
      if (patch.url !== undefined) await safeUrl(patch.url)
      return dto(await edit(scope, id, () => patch))
    },
    async pause(inputScope, id) {
      const scope = snapshotScope(inputScope)
      endpointId(id)
      await requireOwner(scope)
      return dto(await edit(scope, id, () => ({ status: 'paused' })))
    },
    async resume(inputScope, id) {
      const scope = snapshotScope(inputScope)
      endpointId(id)
      await requireOwner(scope)
      return dto(
        await edit(scope, id, async (row) => {
          await safeUrl(row.url)
          return { status: 'active' }
        }),
      )
    },
    async remove(inputScope, id) {
      const scope = snapshotScope(inputScope)
      endpointId(id)
      return remove(scope, id)
    },
    async rotateSecret(inputScope, id, input = {}) {
      const scope = snapshotScope(inputScope)
      endpointId(id)
      inputObject(input, 'Rotation options')
      const graceMs = input.graceMs ?? MAX_ROTATION_GRACE_MS
      if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > MAX_ROTATION_GRACE_MS)
        invalid('Secret rotation graceMs must be an integer from 0 to 86400000.')
      await requireOwner(scope)
      const secret = generateSecret()
      const encryptedSecret = await cipher.encrypt(secret)
      const row = await edit(scope, id, (current) => {
        if (
          graceMs > 0 &&
          current.previousEncryptedSecret &&
          current.previousSecretExpiresAt &&
          current.previousSecretExpiresAt.getTime() > Date.now()
        )
          throw new WebhookError(
            'INVALID_STATE',
            'A signing-secret overlap is still active. Wait for it to expire or explicitly rotate with graceMs: 0.',
          )
        return {
          encryptedSecret,
          previousEncryptedSecret: graceMs > 0 ? current.encryptedSecret : null,
          previousSecretExpiresAt: graceMs > 0 ? new Date(Date.now() + graceMs) : null,
        }
      })
      return { endpoint: dto(row), secret }
    },
    async removeScope(inputScope) {
      const scope = snapshotScope(inputScope)
      for (const row of await repository.list(scope)) await remove(scope, row.id)
    },
    async reencrypt(inputScope) {
      const scope = snapshotScope(inputScope)
      await requireOwner(scope)
      let rewritten = 0
      for (const row of await repository.list(scope)) {
        const updated = await edit(
          scope,
          row.id,
          async (current) => {
            const retainPrevious =
              current.previousEncryptedSecret !== null &&
              current.previousSecretExpiresAt !== null &&
              current.previousSecretExpiresAt.getTime() > Date.now()
            return {
              encryptedSecret: await cipher.encrypt(await cipher.decrypt(current.encryptedSecret)),
              previousEncryptedSecret: retainPrevious
                ? await cipher.encrypt(await cipher.decrypt(current.previousEncryptedSecret!))
                : null,
              previousSecretExpiresAt: retainPrevious ? current.previousSecretExpiresAt : null,
            }
          },
          true,
        )
        if (updated.status !== 'deleted') rewritten++
      }
      return rewritten
    },
  }
}
