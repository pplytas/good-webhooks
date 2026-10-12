import { WebhookError } from './errors.js'
import { POSTGRES_SCHEMA_VERSION, postgresTables } from './postgres-schema.js'
import type { PostgresComponent } from './postgres-schema.js'
import type { Database } from './types.js'

export function postgresCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined
}

const MISSING_RELATION_CODES = ['42P01', '3F000', '42703']

function mismatch(message: string, cause?: unknown): WebhookError {
  return new WebhookError('SCHEMA_MISMATCH', message, cause === undefined ? undefined : { cause })
}

/**
 * Read the recorded schema version for one component and require the version this package supports.
 * Never changes anything. Every message names the SQL the host must apply next.
 */
export async function assertPostgresSchemaVersion(
  database: Database,
  schema: string,
  component: PostgresComponent,
): Promise<void> {
  const tables = postgresTables(schema)
  const generate = `getPostgresMigration({ schema: ${JSON.stringify(schema)}, component: '${component}' })`
  const upgrade = `getPostgresUpgrade({ schema: ${JSON.stringify(schema)}, component: '${component}', from: 3 })`
  let rows: Record<string, unknown>[]
  try {
    rows = (await database.query<Record<string, unknown>>(`SELECT * FROM ${tables.schemaVersion}`))
      .rows
  } catch (error) {
    if (!MISSING_RELATION_CODES.includes(postgresCode(error) ?? '')) throw error
    if (component === 'management' && postgresCode(error) === '42P01') {
      // Management storage shipped without a version table before schema 4. Confirm the table is there first.
      try {
        await database.query(`SELECT 1 FROM ${tables.endpoints} LIMIT 0`)
      } catch (inner) {
        if (MISSING_RELATION_CODES.includes(postgresCode(inner) ?? ''))
          throw mismatch(
            `Management schema ${JSON.stringify(schema)} is missing. Generate SQL with ${generate}.`,
            inner,
          )
        throw inner
      }
      throw mismatch(
        `Management schema ${JSON.stringify(schema)} predates schema version ${POSTGRES_SCHEMA_VERSION} and records no version. Apply ${upgrade}.`,
        error,
      )
    }
    throw mismatch(
      `Webhook ${component} schema ${JSON.stringify(schema)} is missing or incompatible. Generate matching SQL with ${generate}.`,
      error,
    )
  }
  const legacy = rows.length > 0 && rows.every((row) => !('component' in row))
  if (legacy) {
    const versions = rows.map((row) => Number(row.version))
    if (versions.length === 1 && versions[0] === 3)
      throw mismatch(
        `Webhook schema ${JSON.stringify(schema)} is at version 3. Apply ${upgrade} before starting this package version.`,
      )
    throw mismatch(
      `Webhook schema ${JSON.stringify(schema)} records unsupported version ${versions.join(', ')}. Pre-release prototypes need fresh storage; the shipped SQL upgrades version 3 and later only.`,
    )
  }
  const row = rows.find((candidate) => candidate.component === component)
  if (!row)
    throw mismatch(
      component === 'management'
        ? `Webhook schema ${JSON.stringify(schema)} records no management version. Apply ${upgrade}.`
        : `Webhook schema ${JSON.stringify(schema)} records no delivery version. Generate SQL with ${generate}.`,
    )
  const version = Number(row.version)
  if (version === POSTGRES_SCHEMA_VERSION) return
  if (version < POSTGRES_SCHEMA_VERSION)
    throw mismatch(
      `Webhook ${component} schema ${JSON.stringify(schema)} is at version ${version}; this package needs ${POSTGRES_SCHEMA_VERSION}. Apply getPostgresUpgrade({ schema: ${JSON.stringify(schema)}, component: '${component}', from: ${version} }).`,
    )
  throw mismatch(
    `Webhook ${component} schema ${JSON.stringify(schema)} is at version ${version}, newer than the ${POSTGRES_SCHEMA_VERSION} this package supports. Upgrade the good-webhooks package before starting this process.`,
  )
}
