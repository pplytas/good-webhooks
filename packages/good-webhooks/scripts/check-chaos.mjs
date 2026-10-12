// Chaos rehearsal: a draining backlog survives killed database connections, a long exclusive
// table lock, receivers that fail once, and receivers that hang once. Every event is received
// exactly once by its receiver's deduplication and every delivery ends succeeded.
// Use a dedicated disposable PostgreSQL database. Only this run's unique schema is removed.
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { generateEncryptionKey } from 'good-webhooks'
import { getPostgresMigration } from 'good-webhooks/migrations'
import { parseWebhook } from 'good-webhooks/verify'
import { database, events, limits, webhooks } from './chaos/config.mjs'

assert(
  process.env.TEST_DATABASE_URL,
  'Set TEST_DATABASE_URL explicitly to a dedicated disposable PostgreSQL database.',
)
const schema = `gw_chaos_${randomUUID().replaceAll('-', '')}`
const pool = database(process.env.TEST_DATABASE_URL, 'good-webhooks-chaos-control')
const encryptionKey = generateEncryptionKey()
const app = webhooks(pool, schema, encryptionKey)
const started = performance.now()
const deadline = started + 90_000
const counts = { steady: 400, flaky: 60, hang: 20 }
const total = counts.steady + counts.flaky + counts.hang
const secrets = new Map()
const failures = []
const workers = []
const restarts = []
let schemaCreated = false
let supervising = true

pool.on('error', (error) => failures.push(error))

function healthy() {
  assert(performance.now() < deadline, 'Chaos rehearsal exceeded its 90-second budget.')
  if (failures.length) throw new AggregateError(failures, 'Receiver or control database failed.')
}

async function waitUntil(predicate, label, budgetMs = 15_000) {
  const end = Math.min(deadline, performance.now() + budgetMs)
  while (performance.now() < end) {
    healthy()
    if (await predicate()) return
    await sleep(25)
  }
  throw new Error(`Timed out waiting for ${label}.`)
}

async function receive(request, response) {
  const lane = request.url.slice(1)
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const event = await parseWebhook({
    body: Buffer.concat(chunks),
    headers: request.headers,
    secret: secrets.get(lane),
    events,
  })
  assert.equal(event.data.lane, lane, 'Delivery reached the wrong receiver.')
  const receipt = await pool.query(
    `INSERT INTO "${schema}".receipts(event_id,lane,sequence) VALUES ($1,$2,$3)
     ON CONFLICT (event_id) DO UPDATE SET requests=receipts.requests+1 RETURNING requests`,
    [event.id, lane, event.data.sequence],
  )
  const first = receipt.rows[0].requests === 1
  if (lane === 'flaky' && first) return response.writeHead(503).end()
  if (lane === 'hang' && first) return // never answered; the sender times out at limits.timeoutMs
  response.writeHead(204).end()
}
const receiver = createServer((request, response) => {
  void receive(request, response).catch((error) => {
    failures.push(error)
    response.writeHead(500).end()
  })
})

function startWorker(reason) {
  const child = fork(new URL('./chaos/worker.mjs', import.meta.url), [], {
    env: { ...process.env, CHAOS_SCHEMA: schema, CHAOS_ENCRYPTION_KEY: encryptionKey },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const running = { child, ready: false, closed: null, stderr: '', reason }
  child.stderr
    .setEncoding('utf8')
    .on('data', (chunk) => (running.stderr = (running.stderr + chunk).slice(-4000)))
  child.on('message', (message) => message.ready && (running.ready = true))
  child.on('error', (error) => failures.push(error))
  child.once('close', (code, signal) => {
    running.closed = { code, signal }
    // Supervisor: a worker that exits during the rehearsal is restarted with backoff, like production.
    if (supervising) {
      restarts.push({
        reason: running.reason,
        closed: running.closed,
        stderr: running.stderr.trim(),
      })
      setTimeout(() => supervising && startWorker('restart'), 200).unref()
    }
  })
  workers.push(running)
  return running
}
const live = () => workers.filter((worker) => !worker.closed)

async function succeeded() {
  const result = await pool.query(
    `SELECT count(*) FILTER (WHERE status='succeeded')::int AS ok,
            count(*) FILTER (WHERE status IN ('failed','cancelled'))::int AS bad
     FROM "${schema}".webhook_deliveries`,
  )
  assert.equal(result.rows[0].bad, 0, 'A delivery failed or was cancelled.')
  return result.rows[0].ok
}

try {
  await pool.query(`CREATE SCHEMA "${schema}"`)
  schemaCreated = true
  await pool.query(getPostgresMigration({ schema }))
  await pool.query(`CREATE TABLE "${schema}".receipts (
    event_id uuid PRIMARY KEY, lane text NOT NULL, sequence integer NOT NULL,
    requests integer NOT NULL DEFAULT 1, UNIQUE(lane,sequence))`)
  await app.check()
  receiver.listen(0, '127.0.0.1')
  await once(receiver, 'listening')
  const port = receiver.address().port
  for (const lane of Object.keys(counts)) {
    const scope = app.forScope({ type: 'chaos', id: lane })
    const created = await scope.endpoints.create({
      url: `http://127.0.0.1:${port}/${lane}`,
      eventTypes: ['chaos.event'],
    })
    secrets.set(lane, created.secret)
    await scope.deliverySettings.set(created.endpoint.id, { maxInFlight: 8 })
  }
  for (const [lane, count] of Object.entries(counts))
    for (let sequence = 0; sequence < count; sequence++)
      await app.forScope({ type: 'chaos', id: lane }).publish({
        type: 'chaos.event',
        data: { lane, sequence },
        idempotencyKey: `${lane}:${sequence}`,
      })

  startWorker('initial')
  startWorker('initial')
  await waitUntil(
    () => live().length === 2 && live().every((worker) => worker.ready),
    'two workers ready',
  )

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
  await waitUntil(
    () => live().length === 2 && live().every((worker) => worker.ready),
    'replacement workers ready',
  )
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
  await waitUntil(
    () => live().length === 2 && live().every((worker) => worker.ready),
    'workers after the lock',
  )

  // Drain to completion through the flaky and hanging receivers.
  await waitUntil(
    async () => (await succeeded()) === total,
    `${total} deliveries to succeed`,
    45_000,
  )
  assert((await succeeded()) > afterKill, 'No progress after the connection kill.')

  supervising = false
  for (const worker of live()) worker.child.kill('SIGTERM')
  await waitUntil(() => live().length === 0, 'workers to stop on SIGTERM', 8000)
  for (const worker of workers)
    if (worker.closed.signal === null && worker.closed.code === 0) continue
    else
      assert(
        restarts.some((restart) => restart.closed === worker.closed),
        `Worker ended unexpectedly: ${JSON.stringify(worker.closed)} ${worker.stderr}`,
      )

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
  assert(
    (outcomes.abandoned ?? 0) >= 1,
    'Terminating worker connections mid-send must leave abandoned attempts that were then recovered.',
  )
  const report = {
    phase: 'complete',
    deliveries: total,
    restarts: restarts.map((restart) => ({ reason: restart.reason, ...restart.closed })),
    attempts: outcomes,
    receiverRequests: Object.fromEntries(receipts.rows.map((row) => [row.lane, row.requests])),
    elapsedMs: Math.round(performance.now() - started),
  }
  console.log(JSON.stringify(report))
} finally {
  supervising = false
  for (const worker of live()) worker.child.kill('SIGKILL')
  await new Promise((resolve) => receiver.close(resolve))
  if (schemaCreated) await pool.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {})
  await pool.end()
}
