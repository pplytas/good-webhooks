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
import { database, events, limits, webhooks } from './operations/config.mjs'

assert(
  process.env.TEST_DATABASE_URL,
  'Set TEST_DATABASE_URL explicitly to a dedicated disposable PostgreSQL database.',
)
const schema = `gw_ops_${randomUUID().replaceAll('-', '')}`
const pool = database(process.env.TEST_DATABASE_URL)
const encryptionKey = generateEncryptionKey()
const app = webhooks(pool, schema, encryptionKey)
const started = performance.now()
const deadline = started + 50_000
const children = []
const secrets = new Map()
const expected = new Map()
const failures = []
let holdCrash = true
let schemaCreated = false
let worker
let report

function healthy() {
  assert(performance.now() < deadline, 'Operational rehearsal exceeded its 50-second budget.')
  if (failures.length) throw new AggregateError(failures, 'Receiver or database failed.')
  if (worker?.closed) {
    throw new Error(`Worker exited unexpectedly: ${JSON.stringify(worker.closed)} ${worker.stderr}`)
  }
}

pool.on('error', (error) => failures.push(error))

async function waitUntil(predicate, label, budgetMs = 10_000) {
  const end = Math.min(deadline, performance.now() + budgetMs)
  while (performance.now() < end) {
    healthy()
    if (await predicate()) return
    await sleep(20)
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
  // Persist before acknowledgement. A retry must keep the same event ID.
  if (lane === 'slow' && receipt.rows[0].requests === 1) return
  if (lane === 'crash' && holdCrash) return
  response.writeHead(204).end()
}

const receiver = createServer((request, response) => {
  void receive(request, response).catch((error) => {
    failures.push(error)
    response.writeHead(500).end()
  })
})

function startWorker() {
  const child = fork(new URL('./operations/worker.mjs', import.meta.url), [], {
    env: {
      ...process.env,
      OPERATIONS_SCHEMA: schema,
      OPERATIONS_ENCRYPTION_KEY: encryptionKey,
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const running = { child, ready: false, closed: null, stderr: '' }
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    running.stderr = (running.stderr + chunk).slice(-8000)
  })
  child.on('message', (message) => {
    if (message.ready) running.ready = true
  })
  child.on('error', (error) => failures.push(error))
  running.exited = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      running.closed = { code, signal }
      resolve(running.closed)
    })
  })
  children.push(running)
  worker = running
  return running
}

async function stopWorker(signal) {
  const current = worker
  worker = undefined
  assert(current.child.kill(signal), `Could not send ${signal} to the worker.`)
  await waitUntil(() => current.closed, `worker exit after ${signal}`, 5000)
  assert.deepEqual(
    current.closed,
    signal === 'SIGKILL' ? { code: null, signal } : { code: 0, signal: null },
    `Unexpected worker exit: ${current.stderr}`,
  )
  assert.equal(current.stderr, '', 'Worker wrote an unexpected error.')
}

async function publish(lane, count) {
  for (let sequence = 0; sequence < count; sequence++) {
    healthy()
    const result = await app.forScope({ type: 'rehearsal', id: lane }).publish({
      type: 'rehearsal.event',
      data: { lane, sequence },
      idempotencyKey: `${lane}:${sequence}`,
    })
    assert.equal(result.deliveryCount, 1, 'Each event must queue exactly one delivery.')
    expected.set(result.eventId, { lane, sequence })
  }
}

async function counts() {
  const result = await pool.query(
    `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE status='succeeded')::int AS succeeded,
       count(*) FILTER (WHERE status IN ('failed','cancelled'))::int AS failed
     FROM "${schema}".webhook_deliveries`,
  )
  assert.equal(result.rows[0].failed, 0, 'A persistent delivery failed or was cancelled.')
  return result.rows[0]
}

try {
  // CREATE without IF NOT EXISTS establishes ownership before any cleanup can occur.
  await pool.query(`CREATE SCHEMA "${schema}"`)
  schemaCreated = true
  await pool.query(getPostgresMigration({ schema }))
  await pool.query(`CREATE TABLE "${schema}".receipts (
    event_id uuid PRIMARY KEY, lane text NOT NULL, sequence integer NOT NULL,
    requests integer NOT NULL DEFAULT 1, UNIQUE(lane,sequence)
  )`)
  await app.check()
  receiver.listen(0, '127.0.0.1')
  await once(receiver, 'listening')
  const port = receiver.address().port
  for (const [lane, maxInFlight] of [
    ['fast', 16],
    ['slow', 2],
    ['crash', 4],
  ]) {
    const scope = app.forScope({ type: 'rehearsal', id: lane })
    const created = await scope.endpoints.create({
      url: `http://127.0.0.1:${port}/${lane}`,
      eventTypes: ['rehearsal.event'],
    })
    secrets.set(lane, created.secret)
    await scope.deliverySettings.set(created.endpoint.id, { maxInFlight })
  }

  await publish('slow', 2)
  await publish('fast', 300)
  assert.deepEqual(await counts(), { total: 302, succeeded: 0, failed: 0 })
  const drainStarted = performance.now()
  startWorker()
  await waitUntil(() => worker.ready, 'first worker startup')
  await waitUntil(
    async () => (await counts()).succeeded === 302,
    '302 queued deliveries to drain',
    20_000,
  )
  const drainMs = Math.round(performance.now() - drainStarted)
  const slowAttempts = await pool.query(
    `SELECT a.number,a.outcome,a.error,a.response_status FROM "${schema}".webhook_attempts a
     JOIN "${schema}".webhook_deliveries d ON d.id=a.delivery_id
     JOIN "${schema}".receipts r ON r.event_id=d.event_id WHERE r.lane='slow'
     ORDER BY a.delivery_id,a.number`,
  )
  assert.deepEqual(
    slowAttempts.rows,
    Array.from({ length: 2 }, () => [
      { number: 1, outcome: 'retry', error: 'timeout', response_status: null },
      { number: 2, outcome: 'succeeded', error: null, response_status: 204 },
    ]).flat(),
    'Both held receiver requests must time out and then succeed on retry.',
  )
  await stopWorker('SIGTERM')
  console.log(JSON.stringify({ phase: 'backlog', deliveries: 302, slowTimeouts: 2, drainMs }))

  await publish('crash', 12)
  startWorker()
  await waitUntil(() => worker.ready, 'worker startup before crash')
  await waitUntil(async () => {
    const result = await pool.query(
      `SELECT count(*)::int AS count FROM "${schema}".receipts WHERE lane='crash'`,
    )
    return result.rows[0].count === 4
  }, 'four durable receipts before acknowledgement')
  const interrupted = await pool.query(
    `SELECT id,event_id,lease_expires_at FROM "${schema}".webhook_deliveries
     WHERE status='in_flight' AND NOT preparing AND lease_expires_at>clock_timestamp()`,
  )
  assert.equal(
    interrupted.rowCount,
    4,
    'Expected four active, unexpired send leases before SIGKILL.',
  )
  await stopWorker('SIGKILL')
  const restartStarted = performance.now()
  holdCrash = false
  startWorker()
  await waitUntil(() => worker.ready, 'replacement worker startup')
  await waitUntil(
    async () => (await counts()).succeeded === 314,
    'natural lease recovery and complete drain',
    15_000,
  )
  const recoveryMs = Math.round(performance.now() - restartStarted)
  await stopWorker('SIGTERM')

  const recovered = await pool.query(
    `SELECT a.number,a.outcome,a.error,a.started_at,d.event_id FROM "${schema}".webhook_attempts a
     JOIN "${schema}".webhook_deliveries d ON d.id=a.delivery_id
     WHERE d.id=ANY($1::bigint[]) ORDER BY d.id,a.number`,
    [interrupted.rows.map((row) => row.id)],
  )
  assert.equal(
    recovered.rowCount,
    8,
    'Every interrupted delivery needs an abandoned and successful attempt.',
  )
  for (const lease of interrupted.rows) {
    const attempts = recovered.rows.filter((row) => row.event_id === lease.event_id)
    assert.deepEqual(
      attempts.map(({ number, outcome }) => ({ number, outcome })),
      [
        { number: 1, outcome: 'abandoned' },
        { number: 2, outcome: 'succeeded' },
      ],
    )
    assert.equal(attempts[0].error, 'Worker lease expired; receiver outcome is unknown')
    assert(
      attempts[1].started_at >= lease.lease_expires_at,
      'A delivery was reclaimed before its lease expired.',
    )
  }

  const receipts = await pool.query(`SELECT * FROM "${schema}".receipts`)
  assert.equal(
    receipts.rowCount,
    expected.size,
    'A published event has no durable receiver receipt.',
  )
  const interruptedIds = new Set(interrupted.rows.map((row) => row.event_id))
  for (const receipt of receipts.rows) {
    assert.deepEqual(
      { lane: receipt.lane, sequence: receipt.sequence },
      expected.get(receipt.event_id),
    )
    assert.equal(
      receipt.requests,
      receipt.lane === 'slow' || interruptedIds.has(receipt.event_id) ? 2 : 1,
    )
  }
  assert.deepEqual(await counts(), { total: 314, succeeded: 314, failed: 0 })
  const unfinished = await pool.query(
    `SELECT count(*)::int AS count FROM "${schema}".webhook_attempts WHERE outcome='started'`,
  )
  assert.equal(unfinished.rows[0].count, 0, 'An attempt remained unfinished after recovery.')
  const storedEvents = await pool.query(`SELECT id FROM "${schema}".webhook_events`)
  assert.deepEqual(
    new Set(storedEvents.rows.map((row) => row.id)),
    new Set(expected.keys()),
    'Persistent events were lost or added.',
  )
  healthy()
  report = {
    phase: 'complete',
    deliveries: 314,
    uniqueReceipts: receipts.rowCount,
    duplicateRequests: receipts.rows.reduce((sum, receipt) => sum + receipt.requests - 1, 0),
    recoveredLeases: interrupted.rowCount,
    recoveryMs,
    limits,
  }
} finally {
  for (const child of children) {
    if (!child.closed) child.child.kill('SIGKILL')
  }
  await Promise.all(children.map((child) => child.exited))
  if (receiver.listening) {
    receiver.closeAllConnections()
    await new Promise((resolve, reject) =>
      receiver.close((error) => (error ? reject(error) : resolve())),
    )
  }
  try {
    if (schemaCreated) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
  } finally {
    await pool.end()
  }
}
console.log(JSON.stringify({ ...report, elapsedMs: Math.round(performance.now() - started) }))
