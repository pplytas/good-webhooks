import assert from 'node:assert/strict'
import { database, limits, webhooks } from './config.mjs'

assert(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required.')
assert(/^gw_chaos_[a-f0-9]+$/.test(process.env.CHAOS_SCHEMA ?? ''))
assert(process.env.CHAOS_ENCRYPTION_KEY, 'CHAOS_ENCRYPTION_KEY is required.')

const stop = new AbortController()
const requestStop = () => stop.abort()
process.on('SIGTERM', requestStop)
const pool = database(process.env.TEST_DATABASE_URL, 'good-webhooks-chaos-worker')
const fail = (error) => {
  console.error(
    JSON.stringify({ event: 'worker.failed', code: error?.code, message: error?.message }),
  )
  process.exitCode = 1
  stop.abort()
}
pool.on('error', fail)
try {
  const app = webhooks(pool, process.env.CHAOS_SCHEMA, process.env.CHAOS_ENCRYPTION_KEY)
  await app.check()
  process.send({ ready: true })
  await app.worker.run({
    signal: stop.signal,
    pollIntervalMs: limits.pollIntervalMs,
    shutdownGraceMs: 1000,
  })
} catch (error) {
  fail(error)
} finally {
  await pool.end()
  process.off('SIGTERM', requestStop)
  process.disconnect()
}
