import { createWebhooks } from 'good-webhooks'
import { Pool } from 'pg'
import { z } from 'zod'

export const limits = { concurrency: 16, timeoutMs: 800, leaseMs: 2000, pollIntervalMs: 20 }

export const events = {
  'chaos.event': z.object({ lane: z.enum(['steady', 'flaky', 'hang']), sequence: z.int() }),
}

export function database(connectionString, applicationName) {
  return new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 2000,
    statement_timeout: 2000,
    query_timeout: 2500,
    application_name: applicationName,
  })
}

export function webhooks(database, schema, encryptionKey) {
  return createWebhooks({
    database,
    schema,
    encryptionKey,
    events,
    allowLocalhost: true,
    delivery: limits,
    retry: { delaysMs: [100, 200, 400, 800], maxAgeMs: 60_000 },
  })
}
