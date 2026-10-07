import { createHash, randomInt, randomUUID } from 'node:crypto'
import type { DBAdapter } from 'better-auth'
import { WebhookError } from '../errors.js'
import { APPLICATION_SCOPE, scopeKey } from '../scope.js'
import type {
  ManagementRepository,
  ManagementScope,
  StoredEndpoint,
  StoredEndpointPatch,
} from '../management/types.js'

const MODEL = 'webhookEndpoint'
const CAPACITY = 1000
const BATCH_SIZE = 50

interface EndpointRow extends StoredEndpoint {
  scopeKey: string
  allocationKey: string
  creationToken: string
  additionalEventTypes: string[]
}

function canonicalScope(scope: ManagementScope): string {
  return scope === null ? APPLICATION_SCOPE : scopeKey(scope)
}

function allocationKeys(key: string): string[] {
  const digest = createHash('sha256').update(key).digest('hex')
  return Array.from({ length: CAPACITY }, (_, slot) => `${digest}:${slot}`)
}

function schemaError(message: string): never {
  throw new WebhookError('SCHEMA_MISMATCH', message)
}

function endpoint(row: EndpointRow): StoredEndpoint {
  if (
    typeof row.id !== 'string' ||
    !row.id ||
    typeof row.url !== 'string' ||
    !(
      row.description === null ||
      row.description === undefined ||
      typeof row.description === 'string'
    ) ||
    !validEventChunk(row.eventTypes) ||
    !validEventChunk(row.additionalEventTypes) ||
    !['active', 'paused', 'deleted'].includes(row.status) ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0 ||
    typeof row.encryptedSecret !== 'string' ||
    !(
      row.previousEncryptedSecret === null ||
      row.previousEncryptedSecret === undefined ||
      typeof row.previousEncryptedSecret === 'string'
    ) ||
    !validDate(row.createdAt) ||
    !validDate(row.updatedAt) ||
    !(
      row.previousSecretExpiresAt === null ||
      row.previousSecretExpiresAt === undefined ||
      validDate(row.previousSecretExpiresAt)
    )
  )
    schemaError('The Better Auth endpoint record has an invalid shape.')
  return {
    id: row.id,
    url: row.url,
    description: row.description ?? null,
    eventTypes: [...row.eventTypes, ...row.additionalEventTypes],
    status: row.status,
    revision: row.revision,
    encryptedSecret: row.encryptedSecret,
    previousEncryptedSecret: row.previousEncryptedSecret ?? null,
    previousSecretExpiresAt: row.previousSecretExpiresAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function validEventChunk(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 50 &&
    value.every(
      (event) => typeof event === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(event),
    )
  )
}

function storedEventTypes(eventTypes: readonly string[]) {
  if (
    eventTypes.length > 100 ||
    !validEventChunk(eventTypes.slice(0, 50)) ||
    !validEventChunk(eventTypes.slice(50))
  ) {
    throw new WebhookError(
      'INVALID_INPUT',
      'An endpoint may subscribe to at most 100 valid event names.',
    )
  }
  return { eventTypes: eventTypes.slice(0, 50), additionalEventTypes: eventTypes.slice(50) }
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

/** Retry only proven uniqueness violations, never an ambiguous network/commit failure. */
function uniqueViolation(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== 'object' || seen.has(error)) return false
  seen.add(error)
  const value = error as Record<string, unknown>
  const code = value.code
  if (
    [
      '23505',
      'ER_DUP_ENTRY',
      'P2002',
      'SQLITE_CONSTRAINT_UNIQUE',
      'SQLITE_CONSTRAINT_PRIMARYKEY',
    ].includes(String(code))
  )
    return true
  if ([1062, 11000, 2601, 2627].includes(Number(code))) return true
  if ([1062, 11000, 2601, 2627].includes(Number(value.errno ?? value.number))) return true
  if ([1555, 2067].includes(Number(value.errcode))) return true
  // D1 and libSQL can wrap SQLite's constraint message without a driver-specific code.
  if (
    typeof value.message === 'string' &&
    /^(?:D1_ERROR: |SQLITE_CONSTRAINT[^:]*: )?UNIQUE constraint failed:/.test(value.message)
  )
    return true
  return uniqueViolation(value.cause, seen) || uniqueViolation(value.originalError, seen)
}

function rolledBack(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== 'object' || seen.has(error)) return false
  seen.add(error)
  const value = error as Record<string, unknown>
  if (['40001', '40P01', 'ER_LOCK_DEADLOCK', 'P2034'].includes(String(value.code))) return true
  if (Number(value.number) === 1205 || Number(value.errno) === 1213) return true
  return rolledBack(value.cause, seen) || rolledBack(value.originalError, seen)
}

async function retryRolledBack<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      if (attempt >= 4 || !rolledBack(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)))
    }
  }
}

/** BA-only persistence; no SQL, raw transaction handle, or delivery schema dependency. */
export function createBetterAuthRepository(
  adapter: Pick<DBAdapter, 'create' | 'findOne' | 'findMany' | 'incrementOne'>,
): ManagementRepository {
  async function readScope(key: string): Promise<EndpointRow[]> {
    const keys = allocationKeys(key)
    const result: EndpointRow[] = []
    const seen = new Set<string>()
    // Each fixed slot is visited exactly once. Concurrent edits cannot shift an offset page.
    for (let start = 0; start < keys.length; start += BATCH_SIZE) {
      const batch = keys.slice(start, start + BATCH_SIZE)
      const rows = await adapter.findMany<EndpointRow>({
        model: MODEL,
        where: [{ field: 'allocationKey', operator: 'in', value: batch }],
        limit: batch.length + 1,
      })
      if (rows.length > batch.length)
        schemaError('Endpoint slot uniqueness is missing or lookup was incomplete.')
      const seenSlots = new Set<string>()
      for (const row of rows) {
        if (
          row.scopeKey !== key ||
          !batch.includes(row.allocationKey) ||
          seenSlots.has(row.allocationKey) ||
          seen.has(row.id)
        ) {
          schemaError('Endpoint lookup returned inconsistent scope or slot data.')
        }
        if (row.status === 'deleted')
          schemaError('A deleted endpoint still occupies a live endpoint slot.')
        endpoint(row)
        seenSlots.add(row.allocationKey)
        seen.add(row.id)
        result.push(row)
      }
    }
    return result
  }

  async function read(key: string, id: string): Promise<EndpointRow | null> {
    const row = await adapter.findOne<EndpointRow>({
      model: MODEL,
      where: [
        { field: 'id', value: id },
        { field: 'scopeKey', value: key },
      ],
    })
    // Database collations must not turn distinct application scope strings into authority.
    return row?.scopeKey === key && row.id === id ? row : null
  }

  return {
    async list(scope) {
      const rows = await readScope(canonicalScope(scope))
      return rows
        .map(endpoint)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
    },
    async get(scope, id) {
      const row = await read(canonicalScope(scope), id)
      return row === null ? null : endpoint(row)
    },
    async create(scope, data) {
      if (data.status === 'deleted')
        throw new WebhookError('INVALID_INPUT', 'New endpoints cannot be deleted.')
      const key = canonicalScope(scope)
      const keys = allocationKeys(key)
      const occupied = new Set((await readScope(key)).map((row) => row.allocationKey))
      const creationToken = randomUUID()
      const start = randomInt(CAPACITY)
      for (let offset = 0; offset < CAPACITY; offset++) {
        const allocationKey = keys[(start + offset) % CAPACITY]!
        if (occupied.has(allocationKey)) continue
        try {
          const row = await retryRolledBack(() =>
            adapter.create<Omit<EndpointRow, 'id'>, EndpointRow>({
              model: MODEL,
              data: {
                ...data,
                ...storedEventTypes(data.eventTypes),
                scopeKey: key,
                allocationKey,
                creationToken,
              },
            }),
          )
          if (
            row.scopeKey !== key ||
            row.allocationKey !== allocationKey ||
            row.creationToken !== creationToken
          ) {
            schemaError('Endpoint creation returned a different endpoint record.')
          }
          return endpoint(row)
        } catch (error) {
          if (!uniqueViolation(error)) throw error
          const occupant = await adapter.findOne<EndpointRow>({
            model: MODEL,
            where: [{ field: 'allocationKey', value: allocationKey }],
          })
          if (!occupant || occupant.scopeKey !== key || occupant.allocationKey !== allocationKey)
            throw error
          // A repeated operation may recover its own committed row, but may not create a second one.
          if (occupant.creationToken === creationToken) return endpoint(occupant)
          endpoint(occupant)
          occupied.add(allocationKey)
        }
      }
      throw new WebhookError(
        'INVALID_STATE',
        `A scope may have at most ${CAPACITY} nondeleted endpoints.`,
      )
    },
    async update(scope, id, revision, patch: StoredEndpointPatch) {
      const key = canonicalScope(scope)
      const existing = await read(key, id)
      if (existing === null || existing.revision !== revision) return null
      if (
        existing.status === 'deleted' &&
        patch.status !== undefined &&
        patch.status !== 'deleted'
      ) {
        throw new WebhookError('INVALID_STATE', 'Deleted endpoints cannot be revived.')
      }
      const set = {
        ...patch,
        ...(patch.eventTypes === undefined ? {} : storedEventTypes(patch.eventTypes)),
        ...(patch.status === 'deleted' ? { allocationKey: `deleted:${randomUUID()}` } : {}),
      }
      const row = await retryRolledBack(() =>
        adapter.incrementOne<EndpointRow>({
          model: MODEL,
          where: [
            { field: 'id', value: id },
            { field: 'scopeKey', value: key },
            { field: 'revision', value: revision },
          ],
          increment: { revision: 1 },
          set,
        }),
      )
      if (row === null) return null
      if (row.scopeKey !== key || row.id !== id)
        schemaError('Endpoint mutation returned a different scope or endpoint.')
      return endpoint(row)
    },
  }
}
