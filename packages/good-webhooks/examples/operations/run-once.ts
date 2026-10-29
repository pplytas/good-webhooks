import { createWebhooks } from 'good-webhooks'
import { Pool } from 'pg'
import { errorDetails, readOperationsConfig } from './config.ts'

type Summary = {
  batches: number
  claimed: number
  succeeded: number
  retried: number
  failed: number
  stale: number
  reason: 'empty' | 'time_budget' | 'signal'
}

const stop = new AbortController()
let pool: Pool | undefined
let failed = false
let phase = 'configuration'
let summary: Summary | undefined
const requestStop = () => stop.abort()
const fail = (error: unknown, at: string) => {
  failed = true
  process.exitCode = 1
  console.error(
    JSON.stringify({ event: 'webhooks.run-once.failed', phase: at, ...errorDetails(error) }),
  )
  stop.abort()
}

process.on('SIGTERM', requestStop)
process.on('SIGINT', requestStop)

try {
  const config = readOperationsConfig('run-once')
  pool = new Pool(config.database)
  pool.on('error', (error) => fail(error, 'pool'))
  const clientError = (error: Error) => fail(error, 'database')
  pool.on('acquire', (client) => client.on('error', clientError))
  pool.on('release', (_error, client) => client.off('error', clientError))
  const webhooks = createWebhooks({ database: pool, ...config.webhooks })
  phase = 'startup'
  await webhooks.check()
  phase = 'deliver'
  const deadline = performance.now() + config.runOnceMaxDurationMs
  const totals = {
    batches: 0,
    claimed: 0,
    succeeded: 0,
    retried: 0,
    failed: 0,
    stale: 0,
  }
  let reason: Summary['reason']
  while (true) {
    if (stop.signal.aborted) {
      reason = 'signal'
      break
    }
    if (performance.now() >= deadline) {
      reason = 'time_budget'
      break
    }
    const result = await webhooks.worker.runOnce({ signal: stop.signal })
    totals.batches += 1
    totals.claimed += result.claimed
    totals.succeeded += result.succeeded
    totals.retried += result.retried
    totals.failed += result.failed
    totals.stale += result.stale
    // A batch claims nothing when the queue is empty, or when the signal
    // interrupted the claim. Do not start another.
    if (result.claimed === 0) {
      reason = stop.signal.aborted ? 'signal' : 'empty'
      break
    }
  }
  summary = { ...totals, reason }
  if (reason === 'time_budget') {
    console.warn(JSON.stringify({ event: 'webhooks.run-once.budget_exhausted', ...summary }))
  }
} catch (error) {
  fail(error, phase)
} finally {
  stop.abort()
  try {
    await pool?.end()
  } catch (error) {
    fail(error, 'close')
  }
  process.off('SIGTERM', requestStop)
  process.off('SIGINT', requestStop)
  if (!failed && summary)
    console.log(JSON.stringify({ event: 'webhooks.run-once.finished', ...summary }))
}
