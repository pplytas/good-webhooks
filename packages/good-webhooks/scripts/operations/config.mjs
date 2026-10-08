import { createWebhooks } from 'good-webhooks'
import { Pool } from 'pg'
import { z } from 'zod'

export const limits = {
  concurrency: 16,
  timeoutMs: 1000,
  leaseMs: 3000,
  pollIntervalMs: 20,
}

export const events = {
  'rehearsal.event': z.object({ lane: z.enum(['fast', 'slow', 'crash']), sequence: z.int() }),
}

export function database(connectionString) {
  return new Pool({
    connectionString,
    max: 20,
    connectionTimeoutMillis: 2000,
    statement_timeout: 2000,
    query_timeout: 2500,
    application_name: 'good-webhooks-operations-check',
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
    retry: { delaysMs: [150, 300, 600], maxAgeMs: 60_000 },
  })
}
