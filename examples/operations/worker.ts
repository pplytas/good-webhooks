import { createWebhooks } from '@pplytas/webhooks'
import { Pool } from 'pg'
import { errorDetails, readOperationsConfig } from './config.ts'

const stop = new AbortController()
let pool: Pool | undefined
let failed = false
let phase = 'configuration'
const requestStop = () => stop.abort()
const fail = (error: unknown, at: string) => {
  failed = true
  process.exitCode = 1
  console.error(
    JSON.stringify({ event: 'webhooks.worker.failed', phase: at, ...errorDetails(error) }),
  )
  stop.abort()
}

// Register process handlers before reading configuration or starting database I/O.
process.on('SIGTERM', requestStop)
process.on('SIGINT', requestStop)

try {
  const config = readOperationsConfig('worker')
  pool = new Pool(config.database)
  // The pool is lazy. This listener exists before the first connection is opened.
  pool.on('error', (error) => fail(error, 'pool'))
  // Pool errors cover idle connections. Transactions also need a checked-out client listener.
  const clientError = (error: Error) => fail(error, 'database')
  pool.on('acquire', (client) => client.on('error', clientError))
  pool.on('release', (_error, client) => client.off('error', clientError))
  const webhooks = createWebhooks({ database: pool, ...config.webhooks })
  phase = 'startup'
  await webhooks.check()
  if (!stop.signal.aborted) {
    console.log(JSON.stringify({ event: 'webhooks.worker.started' }))
    phase = 'run'
    // Unexpected failures stop the process. A supervisor owns restart backoff.
    await webhooks.worker.run({ signal: stop.signal, pollIntervalMs: config.pollIntervalMs })
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
  if (!failed) console.log(JSON.stringify({ event: 'webhooks.worker.stopped' }))
}
