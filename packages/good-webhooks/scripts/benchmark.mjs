// Bounded throughput benchmark with a fixed profile. Use a dedicated disposable PostgreSQL database.
// It measures this library on one machine with local receivers; it is not a capacity guarantee.
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
import { database, profile, webhooks } from './benchmark/config.mjs'

assert(
  process.env.TEST_DATABASE_URL,
  'Set TEST_DATABASE_URL to a dedicated disposable PostgreSQL database.',
)
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
  const running = { child, ready: false, closed: null, stderr: '' }
  child.stderr.setEncoding('utf8').on('data', (chunk) => (running.stderr += chunk))
  child.on('message', (message) => message.ready && (running.ready = true))
  child.on('close', (code, signal) => (running.closed = { code, signal }))
  children.push(running)
  return running
}

async function waitUntil(predicate, label, budgetMs) {
  const end = performance.now() + budgetMs
  while (performance.now() < end) {
    if (failures.length) throw new AggregateError(failures, 'Receiver failed.')
    for (const child of children)
      if (child.closed)
        throw new Error(`Worker exited: ${JSON.stringify(child.closed)} ${child.stderr}`)
    if (await predicate()) return
    await sleep(50)
  }
  throw new Error(`Timed out waiting for ${label}.`)
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
const total = profile.endpoints * profile.eventsPerEndpoint

try {
  const serverVersion = (await pool.query('SHOW server_version')).rows[0].server_version
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

  // Publish: sequential per endpoint, endpoints interleaved, measured as accepted events per second.
  const publishStarted = performance.now()
  for (let sequence = 0; sequence < profile.eventsPerEndpoint; sequence++) {
    await Promise.all(
      Array.from({ length: profile.endpoints }, (_, endpoint) =>
        app.forScope({ type: 'benchmark', id: String(endpoint) }).publish({
          type: 'benchmark.event',
          data: { endpoint, sequence },
          idempotencyKey: `${endpoint}:${sequence}`,
        }),
      ),
    )
  }
  const publishMs = performance.now() - publishStarted

  // Drain: start the workers against the full backlog.
  const startupStarted = performance.now()
  for (let index = 0; index < profile.workers; index++) startWorker()
  await waitUntil(() => children.every((child) => child.ready), 'worker startup', 10_000)
  const startupMs = performance.now() - startupStarted
  const drainStarted = performance.now()
  await waitUntil(
    async () =>
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM "${schema}".webhook_deliveries WHERE status='succeeded'`,
        )
      ).rows[0].n === total,
    `${total} deliveries to succeed`,
    180_000,
  )
  const drainMs = performance.now() - drainStarted
  for (const child of children) child.child.kill('SIGTERM')
  await waitUntil(() => children.every((child) => child.closed), 'worker shutdown', 10_000).catch(
    () => {},
  )

  const outcomes = await pool.query(
    `SELECT outcome, count(*)::int AS n FROM "${schema}".webhook_attempts GROUP BY outcome ORDER BY outcome`,
  )
  const attempts = await pool.query(
    `SELECT extract(epoch FROM (finished_at - started_at)) * 1000 AS ms FROM "${schema}".webhook_attempts WHERE outcome='succeeded' ORDER BY ms`,
  )
  const queue = await pool.query(
    `SELECT extract(epoch FROM (a.finished_at - d.created_at)) * 1000 AS ms FROM "${schema}".webhook_attempts a
     JOIN "${schema}".webhook_deliveries d ON d.id=a.delivery_id WHERE a.outcome='succeeded' ORDER BY ms`,
  )
  const attemptMs = attempts.rows.map((row) => Number(row.ms))
  const queueMs = queue.rows.map((row) => Number(row.ms))
  const report = {
    profile,
    environment: {
      node: process.version,
      postgres: serverVersion,
      os: `${platform()} ${release()}`,
      cpu: `${cpus()[0]?.model ?? 'unknown'} × ${cpus().length}`,
      memoryGb: Math.round(totalmem() / 1024 ** 3),
    },
    publish: {
      events: total,
      seconds: +(publishMs / 1000).toFixed(2),
      eventsPerSecond: Math.round(total / (publishMs / 1000)),
    },
    workerStartupSeconds: +(startupMs / 1000).toFixed(2),
    drain: {
      deliveries: total,
      seconds: +(drainMs / 1000).toFixed(2),
      deliveriesPerSecond: Math.round(total / (drainMs / 1000)),
    },
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
    receiverRequests: received,
  }
  assert.equal(
    report.attempts.succeeded,
    total,
    'Every delivery must succeed exactly once in this profile.',
  )
  console.log(JSON.stringify(report, null, 2))
} finally {
  for (const child of children) if (!child.closed) child.child.kill('SIGKILL')
  await new Promise((resolve) => receiver.close(resolve))
  if (schemaCreated) await pool.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {})
  await pool.end()
}
