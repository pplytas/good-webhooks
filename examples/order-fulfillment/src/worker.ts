import { readConfig } from './config.ts'
import { createRuntime } from './runtime.ts'

const runtime = createRuntime(readConfig())
const stop = new AbortController()
let deadline: NodeJS.Timeout | undefined
let heartbeat: NodeJS.Timeout | undefined
let heartbeatWrite = Promise.resolve()
const signalStop = () => {
  if (stop.signal.aborted) return
  stop.abort()
  deadline = setTimeout(() => {
    console.error('Worker shutdown deadline exceeded.')
    process.exit(1)
  }, 20000)
  deadline.unref()
}
process.once('SIGTERM', signalStop)
process.once('SIGINT', signalStop)
try {
  await runtime.webhooks.check()
  const beat = async () => {
    await runtime.pool.query(
      `INSERT INTO ${runtime.table('worker_heartbeat')} (singleton, process_id, last_seen_at, stopped_at)
      VALUES (true,$1,now(),NULL) ON CONFLICT (singleton) DO UPDATE SET process_id=$1, last_seen_at=now(), stopped_at=NULL`,
      [process.pid],
    )
  }
  await beat()
  heartbeat = setInterval(() => {
    heartbeatWrite = heartbeatWrite.then(beat).catch((error) => {
      console.error('Worker heartbeat failed:', error.message)
      process.exitCode = 1
      signalStop()
    })
  }, 2000)
  runtime.pool.on('error', (error) => {
    console.error('Worker database connection failed:', error.message)
    process.exitCode = 1
    signalStop()
  })
  console.log('Worker ready. Retry delays: 1s, 3s, 6s.')
  await runtime.webhooks.worker.run({
    signal: stop.signal,
    pollIntervalMs: 250,
    shutdownGraceMs: 5000,
  })
} catch (error) {
  console.error('Worker failed:', error instanceof Error ? error.message : 'unknown error')
  process.exitCode = 1
} finally {
  if (heartbeat) clearInterval(heartbeat)
  await heartbeatWrite
  try {
    await runtime.pool.query(
      `UPDATE ${runtime.table('worker_heartbeat')} SET stopped_at=now() WHERE singleton AND process_id=$1`,
      [process.pid],
    )
  } catch {
    /* Startup may fail before app storage exists. */
  }
  await runtime.pool.end()
  if (deadline) clearTimeout(deadline)
  console.log('Worker stopped.')
}
