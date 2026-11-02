// Chaos rehearsal: a draining backlog survives killed database connections, a long exclusive
// table lock, receivers that fail once, and receivers that hang once. Every event is received
// exactly once by its receiver's deduplication and every delivery ends succeeded.
// --workers N runs the contention mode instead: N supervised workers drain 20,000 events on one
// scope through the same faults plus SIGKILLed workers, while a sampler checks per-endpoint caps
// and expired leases; it ends with a database invariant check (see chaos/contention.mjs).
// Use a dedicated disposable PostgreSQL database. Only this run's unique schema is removed.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { generateEncryptionKey } from 'good-webhooks'
import { contention, database, webhooks } from './chaos/config.mjs'
import { runContention } from './chaos/contention.mjs'
import { createHarness } from './chaos/harness.mjs'

assert(
  process.env.TEST_DATABASE_URL,
  'Set TEST_DATABASE_URL explicitly to a dedicated disposable PostgreSQL database.',
)
const flag = process.argv.indexOf('--workers')
const workerCount = flag === -1 ? null : Number(process.argv[flag + 1])
assert(
  workerCount === null || (Number.isSafeInteger(workerCount) && workerCount > 0),
  '--workers needs a positive integer, for example --workers 16.',
)
const schema = `gw_chaos_${randomUUID().replaceAll('-', '')}`
const pool = database(
  process.env.TEST_DATABASE_URL,
  'good-webhooks-chaos-control',
  workerCount ? contention.controlPoolMax : 10,
)
const encryptionKey = generateEncryptionKey()
const app = webhooks(
  pool,
  schema,
  encryptionKey,
  workerCount ? { retryMaxAgeMs: contention.retryMaxAgeMs } : {},
)
const harness = createHarness({
  app,
  pool,
  schema,
  encryptionKey,
  mode: workerCount ? 'contention' : 'rehearsal',
  label: workerCount ? 'Chaos contention' : 'Chaos rehearsal',
  budgetMs: workerCount ? contention.budgetMs : 90_000,
})

async function rehearsal() {
  const { waitUntil, startWorker, succeeded, restarts, allReady } = harness
  const counts = { steady: 400, flaky: 60, hang: 20 }
  const total = counts.steady + counts.flaky + counts.hang
  const lane = (name) => ({
    lane: name,
    scope: { type: 'chaos', id: name },
    eventType: 'chaos.event',
  })
  await harness.setup(Object.keys(counts).map(lane), 8)
  for (const [name, count] of Object.entries(counts)) await harness.publishLane(lane(name), count)

  startWorker('initial')
  startWorker('initial')
  await waitUntil(() => allReady(2), 'two workers ready')

  // Chaos 1: PostgreSQL terminates every worker connection mid-drain.
  await waitUntil(async () => (await succeeded()) >= 40, 'the drain to be under way')
  const terminated = await pool.query(
    `SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity
     WHERE datname=current_database() AND application_name='good-webhooks-chaos-worker'`,
  )
  assert(
    terminated.rows[0].n >= 2,
    `Expected to terminate worker connections, got ${terminated.rows[0].n}.`,
  )
  await waitUntil(
    () => restarts.length >= 1,
    'a worker to exit after its connections were terminated',
  )
  await waitUntil(() => allReady(2), 'replacement workers ready')
  const afterKill = await succeeded()

  // Chaos 2: an exclusive lock on the deliveries table for longer than the statement timeout, as a
  // migration or VACUUM FULL would take. Workers either wait it out or exit and get restarted.
  const locker = await pool.connect()
  await locker.query('BEGIN')
  await locker.query(`SET LOCAL statement_timeout = 0`)
  await locker.query(`LOCK TABLE "${schema}".webhook_deliveries IN ACCESS EXCLUSIVE MODE`)
  await sleep(2500)
  await locker.query('ROLLBACK')
  locker.release()
  await waitUntil(() => allReady(2), 'workers after the lock')

  // Drain to completion through the flaky and hanging receivers.
  await waitUntil(
    async () => (await succeeded()) === total,
    `${total} deliveries to succeed`,
    45_000,
  )
  assert((await succeeded()) > afterKill, 'No progress after the connection kill.')
  await harness.stopWorkers()

  const receipts = await pool.query(
    `SELECT lane, count(*)::int AS events, sum(requests)::int AS requests FROM "${schema}".receipts GROUP BY lane ORDER BY lane`,
  )
  const byLane = Object.fromEntries(receipts.rows.map((row) => [row.lane, row]))
  assert.equal(byLane.steady.events, counts.steady)
  assert.equal(byLane.flaky.events, counts.flaky)
  assert.equal(byLane.hang.events, counts.hang)
  assert(
    byLane.flaky.requests >= counts.flaky * 2,
    'Flaky events must have been retried after the 503.',
  )
  assert(
    byLane.hang.requests >= counts.hang * 2,
    'Hanging events must have been retried after the timeout.',
  )
  const attempts = await pool.query(
    `SELECT outcome, count(*)::int AS n FROM "${schema}".webhook_attempts GROUP BY outcome ORDER BY outcome`,
  )
  const outcomes = Object.fromEntries(attempts.rows.map((row) => [row.outcome, row.n]))
  assert.equal(
    outcomes.succeeded,
    total,
    'Every delivery must record exactly one successful attempt.',
  )
  // A receiver failure whose worker connection was killed is recorded as abandoned instead of retry.
  assert(
    outcomes.retry + (outcomes.abandoned ?? 0) >= counts.flaky + counts.hang,
    `Receiver failures must be recorded as retries or abandoned: ${JSON.stringify({ outcomes, byLane })}`,
  )
  // Abandoned attempts appear only when the kill lands on a connection writing an outcome, so the
  // report shows their count without requiring one. test/worker.test.ts covers their recovery.
  return {
    phase: 'complete',
    deliveries: total,
    restarts: restarts.map((restart) => ({ reason: restart.reason, ...restart.closed })),
    attempts: outcomes,
    receiverRequests: Object.fromEntries(receipts.rows.map((row) => [row.lane, row.requests])),
    elapsedMs: Math.round(performance.now() - harness.started),
  }
}

try {
  const report = workerCount
    ? await runContention({ harness, pool, schema, workers: workerCount })
    : await rehearsal()
  console.log(JSON.stringify(report))
} finally {
  await harness.close()
}
