import { Pool } from 'pg'
import { createWebhooks } from 'good-webhooks'
import type { Config } from './config.ts'
import { events } from './events.ts'

export function makePool(config: Config) {
  return new Pool({
    connectionString: config.databaseUrl,
    max: 8,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    query_timeout: 11000,
    idle_in_transaction_session_timeout: 10000,
  })
}
export function createRuntime(config: Config) {
  const pool = makePool(config)
  const webhooks = createWebhooks({
    database: pool,
    schema: config.schema,
    events,
    encryptionKey: config.encryptionKey,
    allowLocalhost: true,
    retry: { delaysMs: [1000, 3000, 6000], maxAgeMs: 60 * 60 * 1000 },
    delivery: { timeoutMs: 3000, concurrency: 4, leaseMs: 15000 },
  })
  const table = (name: string) => `"${config.schema}"."${name}"`
  return { config, pool, webhooks, table }
}
export type Runtime = ReturnType<typeof createRuntime>
