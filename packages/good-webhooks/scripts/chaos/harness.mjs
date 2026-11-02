// Shared chaos harness: schema setup, the deduplicating receiver, and the worker supervisor.
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { getPostgresMigration } from 'good-webhooks/migrations'
import { parseWebhook } from 'good-webhooks/verify'
import { events } from './config.mjs'

/**
 * Lanes are endpoint names and URL paths. 'flaky' answers 503 to the first request per event,
 * 'hang' never answers the first request per event, and every other lane answers 204.
 */
export function createHarness({ app, pool, schema, encryptionKey, mode, label, budgetMs }) {
  const started = performance.now()
  const deadline = started + budgetMs
  const secrets = new Map()
  const failures = []
  const workers = []
  const restarts = []
  // Open receiver requests per lane, now and at most, to compare with maxInFlight.
  const openRequests = new Map()
  const maxOpenRequests = new Map()
  let supervising = true
  let schemaCreated = false

  pool.on('error', (error) => failures.push(error))

  function healthy() {
    assert(performance.now() < deadline, `${label} exceeded its ${budgetMs / 1000}-second budget.`)
    if (failures.length) throw new AggregateError(failures, 'Receiver or control database failed.')
  }

  async function waitUntil(predicate, what, waitMs = 15_000) {
    const end = Math.min(deadline, performance.now() + waitMs)
    while (performance.now() < end) {
      healthy()
      if (await predicate()) return
      await sleep(25)
    }
    throw new Error(`Timed out waiting for ${what}.`)
  }

  async function receive(request, response) {
    const lane = request.url.slice(1)
    const open = (openRequests.get(lane) ?? 0) + 1
    openRequests.set(lane, open)
    maxOpenRequests.set(lane, Math.max(maxOpenRequests.get(lane) ?? 0, open))
    response.once('close', () => openRequests.set(lane, openRequests.get(lane) - 1))
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const event = await parseWebhook({
      body: Buffer.concat(chunks),
      headers: request.headers,
      secret: secrets.get(lane),
      events,
    })
    assert.equal(event.data.lane, lane, 'Delivery reached the wrong receiver.')
    // Every request is logged with the database clock, so it can be matched to an attempt window.
    const receipt = await pool.query(
      `WITH logged AS (INSERT INTO "${schema}".requests(event_id) VALUES ($1))
       INSERT INTO "${schema}".receipts(event_id,lane,sequence) VALUES ($1,$2,$3)
       ON CONFLICT (event_id) DO UPDATE SET requests=receipts.requests+1 RETURNING requests`,
      [event.id, lane, event.data.sequence],
    )
    const first = receipt.rows[0].requests === 1
    if (lane === 'flaky' && first) return response.writeHead(503).end()
    if (lane === 'hang' && first) return // never answered; the sender times out at limits.timeoutMs
    response.writeHead(204).end()
  }
  const receiver = createServer((request, response) => {
    // Workers only POST. Ignore stray local probes, such as a port scanner's GET /.
    if (request.method !== 'POST') return response.writeHead(404).end()
    void receive(request, response).catch((error) => {
      failures.push(error)
      response.writeHead(500).end()
    })
  })

  /**
   * Create the schema, the receipts table, and one endpoint per { lane, scope, eventType }.
   * Returns a map from endpoint id to lane.
   */
  async function setup(endpoints, maxInFlight) {
    await pool.query(`CREATE SCHEMA "${schema}"`)
    schemaCreated = true
    await pool.query(getPostgresMigration({ schema }))
    await pool.query(`CREATE TABLE "${schema}".receipts (
      event_id uuid PRIMARY KEY, lane text NOT NULL, sequence integer NOT NULL,
      requests integer NOT NULL DEFAULT 1, UNIQUE(lane,sequence))`)
    await pool.query(`CREATE TABLE "${schema}".requests (
      event_id uuid NOT NULL, received_at timestamptz NOT NULL DEFAULT clock_timestamp())`)
    await app.check()
    receiver.listen(0, '127.0.0.1')
    await once(receiver, 'listening')
    const port = receiver.address().port
    const lanes = new Map()
    for (const { lane, scope, eventType } of endpoints) {
      const created = await app.forScope(scope).endpoints.create({
        url: `http://127.0.0.1:${port}/${lane}`,
        eventTypes: [eventType],
      })
      secrets.set(lane, created.secret)
      lanes.set(created.endpoint.id, lane)
      await app.forScope(scope).deliverySettings.set(created.endpoint.id, { maxInFlight })
    }
    return lanes
  }

  async function publishLane({ lane, scope, eventType }, count) {
    for (let sequence = 0; sequence < count; sequence++)
      await app.forScope(scope).publish({
        type: eventType,
        data: { lane, sequence },
        idempotencyKey: `${lane}:${sequence}`,
      })
  }

  function startWorker(reason) {
    const child = fork(new URL('./worker.mjs', import.meta.url), [], {
      env: {
        ...process.env,
        CHAOS_SCHEMA: schema,
        CHAOS_ENCRYPTION_KEY: encryptionKey,
        CHAOS_MODE: mode,
      },
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
      // Supervisor: a worker that exits during the run is restarted with backoff, like production.
      if (supervising) {
        restarts.push({
          reason: running.reason,
          closed: running.closed,
          stderr: running.stderr.trim(),
        })
        // Jittered so a mass exit does not reconnect every pool at the same instant.
        setTimeout(
          () => supervising && startWorker('restart'),
          200 + Math.floor(Math.random() * 800),
        ).unref()
      }
    })
    workers.push(running)
    return running
  }
  const live = () => workers.filter((worker) => !worker.closed)
  const allReady = (count) => live().length === count && live().every((worker) => worker.ready)

  async function succeeded() {
    const result = await pool.query(
      `SELECT count(*) FILTER (WHERE status='succeeded')::int AS ok,
              count(*) FILTER (WHERE status IN ('failed','cancelled'))::int AS bad
       FROM "${schema}".webhook_deliveries`,
    )
    assert.equal(result.rows[0].bad, 0, 'A delivery failed or was cancelled.')
    return result.rows[0].ok
  }

  /** Stop supervising, SIGTERM every worker, and check that every exit was a recorded restart. */
  async function stopWorkers() {
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
  }

  async function close() {
    supervising = false
    for (const worker of live()) worker.child.kill('SIGKILL')
    await new Promise((resolve) => receiver.close(resolve))
    if (schemaCreated) await pool.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {})
    await pool.end()
  }

  return {
    started,
    failures,
    workers,
    restarts,
    maxOpenRequests,
    healthy,
    waitUntil,
    setup,
    publishLane,
    startWorker,
    live,
    allReady,
    succeeded,
    stopWorkers,
    close,
  }
}
