// Bounded throughput benchmark with a fixed profile. Use a dedicated disposable PostgreSQL database.
// It measures this library on one machine with local receivers; it is not a capacity guarantee.
// --history repeats the profile's live phase after seeding millions of succeeded deliveries, with
// prune() running throughout, and reads claim timings from pg_stat_statements. Progress goes to stderr.
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { cpus, platform, release, totalmem } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { generateEncryptionKey } from 'good-webhooks'
import { getPostgresMigration } from 'good-webhooks/migrations'
import { verifyWebhook } from 'good-webhooks/verify'
import { database, history, profile, webhooks } from './benchmark/config.mjs'
import { probePrune, seedHistory, startPruneLoop, tableStats } from './benchmark/history.mjs'
import {
  hasStatementStats,
  missingExtension,
  resetStatementStats,
  statementStats,
} from './benchmark/statements.mjs'

assert(
  process.env.TEST_DATABASE_URL,
  'Set TEST_DATABASE_URL to a dedicated disposable PostgreSQL database.',
)
const historyMode = process.argv.includes('--history')
const schema = `gw_bench_${randomUUID().replaceAll('-', '')}`
const pool = database(process.env.TEST_DATABASE_URL)
const encryptionKey = generateEncryptionKey()
const app = webhooks(pool, schema, encryptionKey)
const secrets = new Map()
const children = []
const failures = []
let received = 0
let schemaCreated = false

const receiver = createServer(async (request, response) => {
  // Workers only POST. Ignore stray local probes, such as a port scanner's GET /.
  if (request.method !== 'POST') return response.writeHead(404).end()
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    verifyWebhook({
      body: Buffer.concat(chunks),
      headers: request.headers,
      secret: secrets.get(request.url.slice(1)),
    })
    if (profile.receiverDelayMs) await sleep(profile.receiverDelayMs)
    received++
    response.writeHead(204).end()
  } catch (error) {
    failures.push(error)
    response.writeHead(500).end()
  }
})

function startWorker() {
  const child = fork(new URL('./benchmark/worker.mjs', import.meta.url), [], {
    env: { ...process.env, BENCHMARK_SCHEMA: schema, BENCHMARK_ENCRYPTION_KEY: encryptionKey },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const running = { child, ready: false, closed: null, stopping: false, stderr: '' }
  child.stderr.setEncoding('utf8').on('data', (chunk) => (running.stderr += chunk))
  child.on('message', (message) => message.ready && (running.ready = true))
  child.on('close', (code, signal) => (running.closed = { code, signal }))
  children.push(running)
  return running
}

async function waitUntil(predicate, label, budgetMs) {
  const end = performance.now() + budgetMs
  while (performance.now() < end) {
    if (failures.length) throw new AggregateError(failures, 'Receiver or prune loop failed.')
    for (const child of children)
      if (child.closed && !child.stopping)
        throw new Error(`Worker exited: ${JSON.stringify(child.closed)} ${child.stderr}`)
    if (await predicate()) return
    await sleep(50)
  }
  throw new Error(`Timed out waiting for ${label}.`)
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
const seconds = (ms) => +(ms / 1000).toFixed(2)
const progress = (message) => console.error(`[benchmark] ${message}`)
const total = profile.endpoints * profile.eventsPerEndpoint

async function setup() {
  await pool.query(`CREATE SCHEMA "${schema}"`)
  schemaCreated = true
  await pool.query(getPostgresMigration({ schema }))
  await app.check()
  receiver.listen(0, '127.0.0.1')
  await once(receiver, 'listening')
  const port = receiver.address().port
  for (let index = 0; index < profile.endpoints; index++) {
    const scope = app.forScope({ type: 'benchmark', id: String(index) })
    const created = await scope.endpoints.create({
      url: `http://127.0.0.1:${port}/${index}`,
      eventTypes: ['benchmark.event'],
    })
    secrets.set(String(index), created.secret)
    await scope.deliverySettings.set(created.endpoint.id, {
      maxInFlight: profile.maxInFlightPerEndpoint,
    })
  }
}

async function environment() {
  const serverVersion = (await pool.query('SHOW server_version')).rows[0].server_version
  return {
    node: process.version,
    postgres: serverVersion,
    os: `${platform()} ${release()}`,
    cpu: `${cpus()[0]?.model ?? 'unknown'} × ${cpus().length}`,
    memoryGb: Math.round(totalmem() / 1024 ** 3),
  }
}

// Publish: sequential per endpoint, endpoints interleaved, measured as accepted events per second.
// History stages prefix the idempotency keys so each stage publishes new events.
async function publishLive(keyPrefix = '') {
  const publishStarted = performance.now()
  for (let sequence = 0; sequence < profile.eventsPerEndpoint; sequence++) {
    await Promise.all(
      Array.from({ length: profile.endpoints }, (_, endpoint) =>
        app.forScope({ type: 'benchmark', id: String(endpoint) }).publish({
          type: 'benchmark.event',
          data: { endpoint, sequence },
          idempotencyKey: `${keyPrefix}${endpoint}:${sequence}`,
        }),
      ),
    )
  }
  const publishMs = performance.now() - publishStarted
  return {
    events: total,
    seconds: seconds(publishMs),
    eventsPerSecond: Math.round(total / (publishMs / 1000)),
  }
}

// Drain: start the workers against the full backlog of deliveries with id > liveFrom, then stop them.
async function drainLive(liveFrom, budgetMs) {
  const startupStarted = performance.now()
  const workers = Array.from({ length: profile.workers }, () => startWorker())
  await waitUntil(() => workers.every((child) => child.ready), 'worker startup', 10_000)
  const startupMs = performance.now() - startupStarted
  const drainStarted = performance.now()
  await waitUntil(
    async () =>
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM "${schema}".webhook_deliveries WHERE status='succeeded' AND id > $1`,
          [liveFrom],
        )
      ).rows[0].n === total,
    `${total} deliveries to succeed`,
    budgetMs,
  )
  const drainMs = performance.now() - drainStarted
  for (const child of workers) {
    child.stopping = true
    child.child.kill('SIGTERM')
  }
  try {
    await waitUntil(() => workers.every((child) => child.closed), 'worker shutdown', 10_000)
  } catch {
    // A straggler must not keep claiming into the next phase.
    for (const child of workers) if (!child.closed) child.child.kill('SIGKILL')
    await waitUntil(() => workers.every((child) => child.closed), 'worker kill', 5000)
  }
  return {
    workerStartupSeconds: seconds(startupMs),
    drain: {
      deliveries: total,
      seconds: seconds(drainMs),
      deliveriesPerSecond: Math.round(total / (drainMs / 1000)),
    },
  }
}

// Latency and outcomes for the live deliveries only (id > liveFrom); seeded history is excluded.
async function measure(liveFrom) {
  const outcomes = await pool.query(
    `SELECT outcome, count(*)::int AS n FROM "${schema}".webhook_attempts WHERE delivery_id > $1
     GROUP BY outcome ORDER BY outcome`,
    [liveFrom],
  )
  const attempts = await pool.query(
    `SELECT extract(epoch FROM (finished_at - started_at)) * 1000 AS ms FROM "${schema}".webhook_attempts
     WHERE outcome='succeeded' AND delivery_id > $1 ORDER BY ms`,
    [liveFrom],
  )
  const queue = await pool.query(
    `SELECT extract(epoch FROM (a.finished_at - d.created_at)) * 1000 AS ms FROM "${schema}".webhook_attempts a
     JOIN "${schema}".webhook_deliveries d ON d.id=a.delivery_id
     WHERE a.outcome='succeeded' AND d.id > $1 ORDER BY ms`,
    [liveFrom],
  )
  const attemptMs = attempts.rows.map((row) => Number(row.ms))
  const queueMs = queue.rows.map((row) => Number(row.ms))
  const measured = {
    attemptLatencyMs: {
      p50: Math.round(percentile(attemptMs, 0.5)),
      p95: Math.round(percentile(attemptMs, 0.95)),
      p99: Math.round(percentile(attemptMs, 0.99)),
    },
    timeInQueueMs: {
      p50: Math.round(percentile(queueMs, 0.5)),
      p95: Math.round(percentile(queueMs, 0.95)),
      max: Math.round(queueMs.at(-1)),
    },
    attempts: Object.fromEntries(outcomes.rows.map((row) => [row.outcome, row.n])),
  }
  assert.equal(
    measured.attempts.succeeded,
    total,
    'Every delivery must succeed exactly once in this profile.',
  )
  return measured
}

async function runProfile() {
  await setup()
  const publish = await publishLive()
  const { workerStartupSeconds, drain } = await drainLive(0, 180_000)
  const measured = await measure(0)
  return {
    profile,
    environment: await environment(),
    publish,
    workerStartupSeconds,
    drain,
    ...measured,
    receiverRequests: received,
  }
}

// One live phase per stage; stop() returns the prune totals, or null when no loop ran.
async function livePhase(index, pruning) {
  const liveFrom = (
    await pool.query(`SELECT coalesce(max(id),0)::text AS id FROM "${schema}".webhook_deliveries`)
  ).rows[0].id
  received = 0
  await resetStatementStats(pool)
  const stopPrune = pruning === 'loop' ? startPruneLoop(app, (error) => failures.push(error)) : null
  let publish, workerStartupSeconds, drain, prune
  try {
    publish = await publishLive(`stage-${index}:${pruning}:`)
    ;({ workerStartupSeconds, drain } = await drainLive(liveFrom, history.drainBudgetMs))
  } finally {
    prune = stopPrune ? await stopPrune() : null
  }
  if (failures.length) throw new AggregateError(failures, 'Receiver or prune loop failed.')
  const claim = await statementStats(pool, schema, {
    names: ['endpointPick', 'deliveryPick', 'reserve', 'expiredScan', 'pruneCandidates'],
    required: ['endpointPick', 'deliveryPick', 'reserve'],
  })
  const measured = await measure(liveFrom)
  return {
    prune,
    publish,
    workerStartupSeconds,
    drain,
    ...measured,
    receiverRequests: received,
    claim,
  }
}

// Each stage runs a discarded warm-up live phase, then a measured one with prune() idle, to isolate
// the cost of history size, then times one prune() call. Schema 7 indexes the replay_of foreign key,
// so the cascade behind prune() no longer scans a scope's deliveries (#153). After the last stage, a
// live phase runs with prune() looping back to back, the documented cleanup shape.
async function runHistory() {
  await setup()
  if (!(await hasStatementStats(pool))) throw new Error(missingExtension)
  const stages = []
  let seeded = 0
  for (const [index, seededRows] of history.stages.entries()) {
    const label = `stage ${index + 1}/${history.stages.length}`
    progress(`${label}: seeding ${seededRows} rows onto ${seeded}`)
    const seedStarted = performance.now()
    await seedHistory(pool, schema, seeded + 1, seededRows)
    seeded += seededRows
    const seedSeconds = seconds(performance.now() - seedStarted)
    const atStart = await tableStats(pool, schema)
    progress(`${label}: seeded in ${seedSeconds} s, ${atStart.deliveries} deliveries in the table`)
    // The bulk load and VACUUM evict the cache. A discarded phase warms it so both measured
    // phases start from the same state.
    await livePhase(index, 'warmup')
    const pruneIdle = await livePhase(index, 'idle')
    progress(`${label}: prune idle, ${pruneIdle.drain.deliveriesPerSecond}/s`)
    const prune = await probePrune(pool, schema, encryptionKey)
    progress(`${label}: one prune() call ${JSON.stringify(prune)}`)
    stages.push({
      seededRows,
      deliveriesAtStart: atStart.deliveries,
      eventsAtStart: atStart.events,
      tableBytes: atStart.tableBytes,
      seedSeconds,
      pruneIdle,
      prune,
    })
    // The full stage as JSON on stderr, so an interrupted run still leaves its finished stages.
    progress(`${label}: ${JSON.stringify(stages.at(-1))}`)
  }
  await livePhase(history.stages.length, 'warmup')
  const pruneLoop = await livePhase(history.stages.length, 'loop')
  progress(`prune looping, ${pruneLoop.drain.deliveriesPerSecond}/s`)
  return {
    mode: 'history',
    profile,
    history,
    environment: {
      ...(await environment()),
      statementStats:
        'claim timings are pg_stat_statements server-side execution times, reset before each live phase',
    },
    stages,
    pruneLoop,
  }
}

try {
  const report = historyMode ? await runHistory() : await runProfile()
  console.log(JSON.stringify(report, null, 2))
} finally {
  for (const child of children) if (!child.closed) child.child.kill('SIGKILL')
  await new Promise((resolve) => receiver.close(resolve))
  if (schemaCreated) await pool.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {})
  await pool.end()
}
