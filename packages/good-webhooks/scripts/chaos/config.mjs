import { createWebhooks } from 'good-webhooks'
import { Pool } from 'pg'
import { z } from 'zod'

export const limits = { concurrency: 16, timeoutMs: 800, leaseMs: 2000, pollIntervalMs: 20 }

/** Fixed contention profile (--workers N): many workers on one scope, under faults. */
export const contention = {
  scope: { type: 'chaos', id: 'contention' },
  counts: {
    'steady-1': 3000,
    'steady-2': 3000,
    'steady-3': 3000,
    'steady-4': 3000,
    'steady-5': 3000,
    'steady-6': 3000,
    flaky: 1600,
    hang: 400,
  },
  maxInFlight: 16,
  controlPoolMax: 20,
  // Generous: 32 workers on a shared 4-CPU Docker VM drain far slower than on an idle host.
  budgetMs: 600_000,
  // The retry window outlasts the run, so only contention, not backlog age, can fail a delivery.
  retryMaxAgeMs: 300_000,
  sampleIntervalMs: 250,
  maxExpiredLeaseMs: 5000,
}

// Publication fans out to every endpoint in a scope subscribed to the type, so the contention
// lanes, which share one scope, each get their own event type: chaos.<lane>.
const payload = z.object({ lane: z.string(), sequence: z.int() })
export const events = Object.fromEntries(
  ['chaos.event', ...Object.keys(contention.counts).map((lane) => `chaos.${lane}`)].map((type) => [
    type,
    payload,
  ]),
)

export function database(connectionString, applicationName, max = 10) {
  return new Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 2000,
    statement_timeout: 2000,
    query_timeout: 2500,
    application_name: applicationName,
  })
}

export function webhooks(database, schema, encryptionKey, { retryMaxAgeMs = 60_000 } = {}) {
  return createWebhooks({
    database,
    schema,
    encryptionKey,
    events,
    allowLocalhost: true,
    delivery: limits,
    retry: { delaysMs: [100, 200, 400, 800], maxAgeMs: retryMaxAgeMs },
  })
}
