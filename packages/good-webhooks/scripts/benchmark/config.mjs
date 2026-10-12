import { createWebhooks } from 'good-webhooks'
import { Pool } from 'pg'
import { z } from 'zod'

/** Fixed configuration. Change it only with the published numbers. */
export const profile = {
  endpoints: 20,
  eventsPerEndpoint: 250,
  maxInFlightPerEndpoint: 8,
  workers: 2,
  concurrency: 32,
  timeoutMs: 5000,
  leaseMs: 15_000,
  pollIntervalMs: 20,
  receiverDelayMs: 5,
}

export const events = {
  'benchmark.event': z.object({ endpoint: z.int(), sequence: z.int() }),
}

export function database(connectionString) {
  return new Pool({
    connectionString,
    max: 20,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10_000,
    application_name: 'good-webhooks-benchmark',
  })
}

export function webhooks(database, schema, encryptionKey) {
  return createWebhooks({
    database,
    schema,
    encryptionKey,
    events,
    allowLocalhost: true,
    delivery: {
      concurrency: profile.concurrency,
      timeoutMs: profile.timeoutMs,
      leaseMs: profile.leaseMs,
    },
  })
}
