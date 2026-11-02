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

/**
 * Large-history mode (--history): the profile's live phase runs after each stage of seeded history.
 * Fixed like profile. Change it only with the published numbers.
 */
export const history = {
  // Succeeded deliveries to add before each live phase, so the table holds about 0, 1M, 3M and 7M.
  // BENCHMARK_HISTORY_STAGES="0,50000" replaces the list for developer smoke tests only. It is never
  // used for published numbers.
  stages: process.env.BENCHMARK_HISTORY_STAGES
    ? process.env.BENCHMARK_HISTORY_STAGES.split(',').map(Number)
    : [0, 1_000_000, 2_000_000, 4_000_000],
  batchSize: 250_000,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  // Seeded events spread evenly over retentionMs / (1 - agedShare), 10 days, so prune always has work.
  agedShare: 0.3,
  drainBudgetMs: 300_000,
}
if (!history.stages.every((rows) => Number.isSafeInteger(rows) && rows >= 0))
  throw new Error('BENCHMARK_HISTORY_STAGES must be a comma-separated list of row counts.')

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

/** Pass { retentionMs } in history mode only; the default profile keeps the library default. */
export function webhooks(database, schema, encryptionKey, options = {}) {
  return createWebhooks({
    database,
    schema,
    encryptionKey,
    events,
    ...(options.retentionMs === undefined ? {} : { retentionMs: options.retentionMs }),
    allowLocalhost: true,
    delivery: {
      concurrency: profile.concurrency,
      timeoutMs: profile.timeoutMs,
      leaseMs: profile.leaseMs,
    },
  })
}
