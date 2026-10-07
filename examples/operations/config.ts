import { events } from '../basic/events.ts'

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value?.trim()) throw new Error(`${name} is required.`)
  return value
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]
  const value = raw === undefined ? fallback : /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`)
  }
  return value
}

/** Importing this module reads no environment, opens no connection, and starts no worker. */
export function readOperationsConfig(
  role: 'worker' | 'cleanup',
  env: NodeJS.ProcessEnv = process.env,
) {
  const connectionString = required(env, 'DATABASE_URL')
  try {
    const url = new URL(connectionString)
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) throw new Error()
  } catch {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL.')
  }
  const encryptionKey = required(env, 'WEBHOOK_ENCRYPTION_KEY')
  const localhost = env.WEBHOOK_ALLOW_LOCALHOST
  if (localhost !== undefined && localhost !== 'true' && localhost !== 'false') {
    throw new Error('WEBHOOK_ALLOW_LOCALHOST must be true or false.')
  }
  const statementTimeout = integer(env, 'WEBHOOK_DB_STATEMENT_TIMEOUT_MS', 10_000, 100, 120_000)
  return {
    database: {
      connectionString,
      application_name: `webhooks-example-${role}`,
      max: 10,
      connectionTimeoutMillis: integer(env, 'WEBHOOK_DB_CONNECT_TIMEOUT_MS', 5_000, 100, 60_000),
      statement_timeout: statementTimeout,
      query_timeout: statementTimeout + 1_000,
      idle_in_transaction_session_timeout: statementTimeout,
      idleTimeoutMillis: 30_000,
    },
    webhooks: {
      events,
      encryptionKey,
      schema: env.WEBHOOK_SCHEMA ?? 'public',
      allowLocalhost: localhost === 'true',
    },
    pollIntervalMs: integer(env, 'WEBHOOK_POLL_INTERVAL_MS', 1_000, 10, 60_000),
    cleanupMaxBatches: integer(env, 'WEBHOOK_CLEANUP_MAX_BATCHES', 20, 1, 1_000),
    cleanupMaxDurationMs: integer(env, 'WEBHOOK_CLEANUP_MAX_DURATION_MS', 30_000, 100, 3_600_000),
  }
}

/** Log operational errors without dumping configuration, payloads, or signing material. */
interface ErrorDetails {
  name: string
  message: string
  code?: string
  causes?: ErrorDetails[]
}
export function errorDetails(error: unknown): ErrorDetails {
  const details = singleErrorDetails(error)
  if (error instanceof AggregateError)
    details.causes = error.errors.slice(0, 10).map(singleErrorDetails)
  return details
}

function singleErrorDetails(error: unknown): ErrorDetails {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : 'Unexpected non-Error failure.',
    ...(error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
      ? { code: error.code }
      : {}),
  }
}
