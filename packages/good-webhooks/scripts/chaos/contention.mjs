// Contention mode: N supervised workers drain 20,000 events on one scope while connections are
// terminated, workers are SIGKILLed, and the deliveries table is locked. A sampler checks the
// per-endpoint cap and expired leases during the drain; the database is then checked for lost
// events, stuck work, unrecorded attempts, and double delivery.
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { hasStatementStats, resetStatementStats, statementStats } from '../benchmark/statements.mjs'
import { contention } from './config.mjs'

const progress = (message) => console.error(`[chaos] ${message}`)

/** Every sampleIntervalMs: in-flight count per endpoint and the oldest expired lease, in one snapshot. */
function startSampler({ pool, schema, lanes, failures }) {
  const maxInFlight = Object.fromEntries([...lanes.values()].map((lane) => [lane, 0]))
  let maxExpiredLeaseMs = 0
  let samples = 0
  let paused = false
  let stopped = false
  let current = Promise.resolve()

  async function sample() {
    const result = await pool.query(
      `SELECT s.endpoint_id, s.max_in_flight,
        (SELECT count(*)::int FROM "${schema}".webhook_deliveries d WHERE d.scope_key=s.scope_key
          AND d.endpoint_id=s.endpoint_id AND d.status='in_flight') AS in_flight,
        (SELECT coalesce(extract(epoch FROM max(now() - d.lease_expires_at)) * 1000, 0)::float8
          FROM "${schema}".webhook_deliveries d WHERE d.scope_key=s.scope_key
          AND d.endpoint_id=s.endpoint_id AND d.status='in_flight' AND d.lease_expires_at <= now())
          AS expired_ms
       FROM "${schema}".webhook_endpoint_state s`,
    )
    samples++
    for (const row of result.rows) {
      const lane = lanes.get(row.endpoint_id)
      maxInFlight[lane] = Math.max(maxInFlight[lane], row.in_flight)
      maxExpiredLeaseMs = Math.max(maxExpiredLeaseMs, row.expired_ms)
      assert(
        row.in_flight <= row.max_in_flight,
        `${lane} had ${row.in_flight} deliveries in flight, above its cap of ${row.max_in_flight}.`,
      )
      assert(
        row.expired_ms < contention.maxExpiredLeaseMs,
        `${lane} kept an expired lease for ${Math.round(row.expired_ms)} ms.`,
      )
    }
  }

  const loop = (async () => {
    while (!stopped) {
      if (!paused) {
        current = sample()
        await current
      }
      await sleep(contention.sampleIntervalMs)
    }
  })().catch((error) => failures.push(error))

  return {
    // Pausing waits for a sample in progress, so no sample queues behind the table lock.
    pause: async () => {
      paused = true
      await current.catch(() => {})
    },
    resume: () => (paused = false),
    stop: async () => {
      stopped = true
      await loop
      return { samples, maxInFlight, maxExpiredLeaseMs: Math.round(maxExpiredLeaseMs) }
    },
  }
}

/** Every check returns a count of violations; the invariant holds when all are zero. */
async function checkInvariants(pool, schema, counts, total) {
  const t = (table) => `"${schema}".${table}`
  const statuses = Object.fromEntries(
    (
      await pool.query(
        `SELECT status, count(*)::int AS n FROM ${t('webhook_deliveries')} GROUP BY status`,
      )
    ).rows.map((row) => [row.status, row.n]),
  )
  const totals = (
    await pool.query(
      `SELECT (SELECT count(*) FROM ${t('webhook_events')})::int AS events,
        (SELECT count(*) FROM ${t('webhook_deliveries')})::int AS deliveries,
        (SELECT count(*) FROM ${t('receipts')})::int AS receipts,
        (SELECT count(*) FROM ${t('receipts')} WHERE requests < 1)::int AS empty_receipts`,
    )
  ).rows[0]
  const receiptLanes = Object.fromEntries(
    (
      await pool.query(
        `SELECT lane, count(*)::int AS n FROM ${t('receipts')} GROUP BY lane ORDER BY lane`,
      )
    ).rows.map((row) => [row.lane, row.n]),
  )
  const attempts = (
    await pool.query(
      `WITH per AS (
        SELECT d.attempt_count AS n, count(a.number)::int AS attempts,
          coalesce(max(a.number), 0) AS max_number, coalesce(sum(a.number), 0)::int AS sum_number,
          count(a.number) FILTER (WHERE a.outcome='started' OR a.finished_at IS NULL)::int AS open,
          count(a.number) FILTER (WHERE a.outcome='succeeded')::int AS succeeded,
          coalesce(bool_or(a.outcome='succeeded' AND a.number=d.attempt_count), false) AS last_succeeded,
          count(a.number) FILTER (WHERE a.number < d.attempt_count
            AND a.outcome NOT IN ('retry','abandoned'))::int AS bad_earlier
        FROM ${t('webhook_deliveries')} d LEFT JOIN ${t('webhook_attempts')} a ON a.delivery_id=d.id
        GROUP BY d.id
      )
      SELECT count(*) FILTER (WHERE attempts <> n)::int AS count_mismatch,
        count(*) FILTER (WHERE max_number <> n OR sum_number <> n * (n + 1) / 2)::int AS numbering,
        count(*) FILTER (WHERE open > 0)::int AS open_attempts,
        count(*) FILTER (WHERE succeeded <> 1 OR NOT last_succeeded)::int AS success_not_last,
        count(*) FILTER (WHERE bad_earlier > 0)::int AS bad_earlier
      FROM per`,
    )
  ).rows[0]
  const doubles = (
    await pool.query(
      `SELECT (SELECT count(*) FROM ${t('receipts')} r JOIN ${t('webhook_deliveries')} d
          ON d.event_id=r.event_id WHERE r.requests > d.attempt_count)::int AS excess_requests,
        (SELECT count(*) FROM ${t('webhook_attempts')} a JOIN ${t('webhook_attempts')} b
          ON b.delivery_id=a.delivery_id AND a.number < b.number AND b.started_at < a.finished_at)::int
          AS overlapping`,
    )
  ).rows[0]
  const violations = {
    noLostEvent: {
      events: totals.events - total,
      deliveries: totals.deliveries - total,
      notSucceeded: total - (statuses.succeeded ?? 0),
      receipts: totals.receipts - total,
      laneReceipts: Object.entries(counts).filter(([lane, n]) => receiptLanes[lane] !== n).length,
      emptyReceipts: totals.empty_receipts,
    },
    everyAttemptRecorded: attempts,
    noDoubleDelivery: doubles,
  }
  return { statuses, violations }
}

export async function runContention({ harness, pool, schema, workers }) {
  const { waitUntil, startWorker, succeeded, restarts, allReady, live, failures } = harness
  const { scope, counts, maxInFlight } = contention
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
  const lanes = Object.keys(counts).map((lane) => ({ lane, scope, eventType: `chaos.${lane}` }))
  const endpointLanes = await harness.setup(lanes, maxInFlight)
  progress(`publishing ${total} events to ${lanes.length} endpoints on one scope`)
  await Promise.all(lanes.map((lane) => harness.publishLane(lane, counts[lane.lane])))
  const statements = await hasStatementStats(pool)
  if (statements) await resetStatementStats(pool)

  progress(`starting ${workers} workers`)
  for (let index = 0; index < workers; index++) startWorker('initial')
  await waitUntil(() => allReady(workers), `${workers} workers ready`, 60_000)
  const drainStarted = performance.now()
  const sampler = startSampler({ pool, schema, lanes: endpointLanes, failures })
  const reached = (share) =>
    waitUntil(async () => (await succeeded()) >= total * share, `${share * 100}% drained`, 120_000)

  // Fault 1 at 10%: PostgreSQL terminates every worker connection.
  await reached(0.1)
  const terminated = await pool.query(
    `SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity
     WHERE datname=current_database() AND application_name='good-webhooks-chaos-worker'`,
  )
  assert(terminated.rows[0].n >= 1, 'Expected to terminate worker connections.')
  progress(`10%: terminated ${terminated.rows[0].n} worker connections`)
  await waitUntil(() => restarts.length >= 1, 'a worker to exit after the terminations')
  await waitUntil(() => allReady(workers), 'replacement workers ready', 60_000)

  // Fault 2 at 30%: SIGKILL two random workers mid-send. Their leases expire and are recovered.
  await reached(0.3)
  const before = restarts.length
  const victims = live()
    .sort(() => Math.random() - 0.5)
    .slice(0, 2)
  for (const victim of victims) victim.child.kill('SIGKILL')
  progress(`30%: killed ${victims.length} workers`)
  await waitUntil(() => restarts.length >= before + victims.length, 'killed workers to exit')
  await waitUntil(() => allReady(workers), 'replacement workers ready', 60_000)

  // Fault 3 at 50%: an exclusive lock on the deliveries table past the statement timeout.
  await reached(0.5)
  await sampler.pause()
  const locker = await pool.connect()
  try {
    await locker.query('BEGIN')
    await locker.query(`SET LOCAL statement_timeout = 0`)
    await locker.query(`LOCK TABLE "${schema}".webhook_deliveries IN ACCESS EXCLUSIVE MODE`)
    progress('50%: holding an exclusive lock on the deliveries table for 2.5 s')
    await sleep(2500)
    await locker.query('ROLLBACK')
  } finally {
    locker.release()
  }
  sampler.resume()
  await waitUntil(() => allReady(workers), 'workers after the lock', 60_000)

  await waitUntil(
    async () => (await succeeded()) === total,
    `${total} deliveries to succeed`,
    contention.budgetMs,
  )
  const drainMs = performance.now() - drainStarted
  const sampled = await sampler.stop()
  if (failures.length) throw new AggregateError(failures, 'Receiver or sampler failed.')
  progress(`drained in ${(drainMs / 1000).toFixed(1)} s; stopping workers`)
  await harness.stopWorkers()

  const claim = statements
    ? await statementStats(pool, schema, {
        names: ['endpointPick', 'deliveryPick', 'reserve', 'expiredScan'],
        required: ['endpointPick', 'deliveryPick', 'reserve'],
      })
    : null
  const { statuses, violations } = await checkInvariants(pool, schema, counts, total)
  const clean = (checks) => Object.values(checks).every((n) => Number(n) === 0)
  const invariants = {
    noLostEvent: clean(violations.noLostEvent),
    noStuckInFlight:
      (statuses.in_flight ?? 0) === 0 && sampled.maxExpiredLeaseMs < contention.maxExpiredLeaseMs,
    everyAttemptRecorded: clean(violations.everyAttemptRecorded),
    noDoubleDelivery: clean(violations.noDoubleDelivery),
    capRespected: Object.values(sampled.maxInFlight).every((n) => n <= maxInFlight),
    // stopWorkers() asserts that every exit was the final SIGTERM or a recorded restart.
    workersSupervised: true,
  }
  for (const [name, holds] of Object.entries(invariants))
    assert(holds, `Invariant ${name} failed: ${JSON.stringify({ statuses, violations, sampled })}`)

  const outcomes = await pool.query(
    `SELECT outcome, count(*)::int AS n FROM "${schema}".webhook_attempts GROUP BY outcome ORDER BY outcome`,
  )
  const requests = await pool.query(
    `SELECT lane, sum(requests)::int AS n FROM "${schema}".receipts GROUP BY lane ORDER BY lane`,
  )
  return {
    mode: 'contention',
    workers,
    deliveries: total,
    drain: {
      seconds: +(drainMs / 1000).toFixed(2),
      deliveriesPerSecond: Math.round(total / (drainMs / 1000)),
    },
    attempts: Object.fromEntries(outcomes.rows.map((row) => [row.outcome, row.n])),
    receiverRequests: Object.fromEntries(requests.rows.map((row) => [row.lane, row.n])),
    restarts: restarts.map((restart) => ({ reason: restart.reason, ...restart.closed })),
    maxInFlightObserved: Object.fromEntries(
      Object.entries(sampled.maxInFlight).map(([lane, max]) => [lane, { max, cap: maxInFlight }]),
    ),
    maxExpiredLeaseMs: sampled.maxExpiredLeaseMs,
    samples: sampled.samples,
    invariants,
    claim,
    elapsedMs: Math.round(performance.now() - harness.started),
  }
}
