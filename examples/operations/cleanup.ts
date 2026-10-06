import { createWebhooks } from '@pplytas/webhooks'
import { Pool } from 'pg'
import { errorDetails, readOperationsConfig } from './config.ts'

const stop = new AbortController()
let pool: Pool | undefined
let failed = false
let phase = 'configuration'
let summary: { batches: number; deleted: number; reason: string } | undefined
const requestStop = () => stop.abort()
const fail = (error: unknown, at: string) => {
  failed = true
  process.exitCode = 1
  console.error(
    JSON.stringify({ event: 'webhooks.cleanup.failed', phase: at, ...errorDetails(error) }),
  )
  stop.abort()
}

process.on('SIGTERM', requestStop)
process.on('SIGINT', requestStop)

try {
  const config = readOperationsConfig('cleanup')
  pool = new Pool(config.database)
  pool.on('error', (error) => fail(error, 'pool'))
  const clientError = (error: Error) => fail(error, 'database')
  pool.on('acquire', (client) => client.on('error', clientError))
  pool.on('release', (_error, client) => client.off('error', clientError))
  const webhooks = createWebhooks({ database: pool, ...config.webhooks })
  phase = 'startup'
  await webhooks.check()
  phase = 'prune'
  const deadline = performance.now() + config.cleanupMaxDurationMs
  let batches = 0
  let deleted = 0
  let reason = 'batch_budget'
  while (batches < config.cleanupMaxBatches) {
    if (stop.signal.aborted) {
      reason = 'signal'
      break
    }
    if (performance.now() >= deadline) {
      reason = 'time_budget'
      break
    }
    const count = await webhooks.worker.prune()
    batches += 1
    deleted += count
    // A short batch can reflect contention. Continue until zero progress or a budget ends.
    if (count === 0) {
      reason = 'no_progress'
      break
    }
  }
  summary = { batches, deleted, reason }
  if (reason === 'batch_budget' || reason === 'time_budget') {
    console.warn(JSON.stringify({ event: 'webhooks.cleanup.budget_exhausted', ...summary }))
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
    console.log(JSON.stringify({ event: 'webhooks.cleanup.finished', ...summary }))
}
