import { randomUUID } from 'node:crypto'
import { decryptSecret, encryptSecret, parseEncryptionKey } from '../crypto.js'
import { WebhookError } from '../errors.js'
import { postgresTables, resolvePostgresSchema } from '../postgres-schema.js'
import { APPLICATION_SCOPE, scopeKey } from '../scope.js'
import type { Database } from '../types.js'
import { createManagement } from './index.js'
import { validateResolvedUrl } from './node-url.js'
import type {
  EndpointManagement,
  ManagementRepository,
  ManagementScope,
  StoredEndpoint,
  StoredEndpointPatch,
} from './types.js'

const ENDPOINT_LIMIT = 1000
const FIELDS = `id,url,description,event_types AS "eventTypes",status,
  secret AS "encryptedSecret",previous_secret AS "previousEncryptedSecret",
  previous_secret_expires_at AS "previousSecretExpiresAt",revision,
  created_at AS "createdAt",updated_at AS "updatedAt"`

function key(scope: ManagementScope): string {
  return scope === null ? APPLICATION_SCOPE : scopeKey(scope)
}

function validateDatabase(database: Database): void {
  if (typeof database?.query !== 'function' || typeof database?.connect !== 'function')
    throw new WebhookError(
      'INVALID_CONFIG',
      'database must provide PostgreSQL query() and connect() methods.',
    )
}

/** PostgreSQL storage for standalone management. Apply migrations/management.sql explicitly. */
export function createPostgresManagementRepository(
  database: Database,
  options: { schema?: string } = {},
): ManagementRepository {
  validateDatabase(database)
  const schema = resolvePostgresSchema(options.schema)
  const table = postgresTables(schema).endpoints
  return {
    async list(scope) {
      const result = await database.query<StoredEndpoint & Record<string, unknown>>(
        `SELECT ${FIELDS} FROM ${table} WHERE scope_key=$1 AND status<>'deleted' ORDER BY created_at DESC,id DESC LIMIT 1001`,
        [key(scope)],
      )
      if (result.rows.length > ENDPOINT_LIMIT)
        throw new WebhookError(
          'INVALID_STATE',
          'The scope exceeds its endpoint limit; recipient enumeration cannot safely continue.',
        )
      return result.rows
    },
    async get(scope, id) {
      const result = await database.query<StoredEndpoint & Record<string, unknown>>(
        `SELECT ${FIELDS} FROM ${table} WHERE scope_key=$1 AND id=$2`,
        [key(scope), id],
      )
      return result.rows[0] ?? null
    },
    async create(scope, endpoint) {
      const scopeId = key(scope)
      const client = await database.connect()
      try {
        await client.query('BEGIN')
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `good-webhooks:management:${JSON.stringify([schema, scopeId])}`,
        ])
        const count = await client.query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM ${table} WHERE scope_key=$1 AND status<>'deleted'`,
          [scopeId],
        )
        if ((count.rows[0]?.count ?? 0) >= ENDPOINT_LIMIT)
          throw new WebhookError(
            'INVALID_STATE',
            `A scope may have at most ${ENDPOINT_LIMIT} nondeleted endpoints.`,
          )
        const result = await client.query<StoredEndpoint & Record<string, unknown>>(
          `INSERT INTO ${table}(id,scope_key,url,description,event_types,status,secret,previous_secret,previous_secret_expires_at,revision,created_at,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${FIELDS}`,
          [
            randomUUID(),
            scopeId,
            endpoint.url,
            endpoint.description,
            endpoint.eventTypes,
            endpoint.status,
            endpoint.encryptedSecret,
            endpoint.previousEncryptedSecret,
            endpoint.previousSecretExpiresAt,
            endpoint.revision,
            endpoint.createdAt,
            endpoint.updatedAt,
          ],
        )
        await client.query('COMMIT')
        return result.rows[0]!
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        client.release()
      }
    },
    async update(scope, id, revision, patch) {
      const columns: Record<keyof StoredEndpointPatch, string> = {
        url: 'url',
        description: 'description',
        eventTypes: 'event_types',
        status: 'status',
        encryptedSecret: 'secret',
        previousEncryptedSecret: 'previous_secret',
        previousSecretExpiresAt: 'previous_secret_expires_at',
        updatedAt: 'updated_at',
      }
      const values: unknown[] = [key(scope), id, revision]
      const setters = ['revision=revision+1']
      for (const name of Object.keys(columns) as (keyof StoredEndpointPatch)[]) {
        if (patch[name] === undefined) continue
        values.push(patch[name])
        setters.push(`${columns[name]}=$${values.length}`)
      }
      const result = await database.query<StoredEndpoint & Record<string, unknown>>(
        `UPDATE ${table} SET ${setters.join(',')}
         WHERE scope_key=$1 AND id=$2 AND revision=$3 AND status<>'deleted' RETURNING ${FIELDS}`,
        values,
      )
      return result.rows[0] ?? null
    },
  }
}

export interface PostgresManagementOptions {
  database: Database
  /** PostgreSQL schema containing webhook_endpoints. Defaults to public. */
  schema?: string
  eventTypes: readonly string[]
  encryptionKey: string | Uint8Array
  /** Old keys remain readable during reencrypt(). Remove only after all affected scopes finish. */
  decryptionKeys?: readonly (string | Uint8Array)[]
  allowLocalhost?: boolean
}

export interface PostgresManagement extends EndpointManagement {
  /** Verify management tables exist. Does not create or migrate storage. */
  check(): Promise<void>
}

export function createPostgresManagement(options: PostgresManagementOptions): PostgresManagement {
  const encryptionKey = parseEncryptionKey(options?.encryptionKey)
  const decryptionKeys = [encryptionKey, ...(options.decryptionKeys ?? []).map(parseEncryptionKey)]
  const database = options.database
  const schema = resolvePostgresSchema(options.schema)
  const table = postgresTables(schema).endpoints
  const allowLocalhost = options.allowLocalhost ?? false
  const management = createManagement({
    repository: createPostgresManagementRepository(database, { schema }),
    eventTypes: options.eventTypes,
    allowLocalhost,
    validateUrl: (url) => validateResolvedUrl(url, allowLocalhost),
    cipher: {
      async encrypt(secret) {
        return encryptSecret(secret, encryptionKey)
      },
      async decrypt(ciphertext) {
        let failure: unknown
        for (const candidate of decryptionKeys) {
          try {
            return decryptSecret(ciphertext, candidate)
          } catch (error) {
            failure = error
          }
        }
        throw failure
      },
    },
  })
  return {
    ...management,
    async check() {
      try {
        await database.query(`SELECT ${FIELDS} FROM ${table} LIMIT 0`)
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
        if (code === '42P01' || code === '3F000' || code === '42703')
          throw new WebhookError(
            'SCHEMA_MISMATCH',
            `Management table ${table} is missing or incompatible. Generate matching SQL with getPostgresMigration({ schema: ${JSON.stringify(schema)}, component: 'management' }).`,
            { cause: error },
          )
        throw error
      }
    },
  }
}
