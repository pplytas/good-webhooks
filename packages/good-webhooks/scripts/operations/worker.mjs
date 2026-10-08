import assert from 'node:assert/strict'
import { database, limits, webhooks } from './config.mjs'

assert(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required.')
assert(/^gw_ops_[a-f0-9]+$/.test(process.env.OPERATIONS_SCHEMA ?? ''))
assert(process.env.OPERATIONS_ENCRYPTION_KEY, 'OPERATIONS_ENCRYPTION_KEY is required.')

const stop = new AbortController()
const requestStop = () => stop.abort()
process.on('SIGTERM', requestStop)
process.on('SIGINT', requestStop)
const pool = database(process.env.TEST_DATABASE_URL)
const fail = (error) => {
  console.error(error)
  process.exitCode = 1
  stop.abort()
}
pool.on('error', fail)

try {
  const app = webhooks(pool, process.env.OPERATIONS_SCHEMA, process.env.OPERATIONS_ENCRYPTION_KEY)
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
  process.off('SIGINT', requestStop)
  process.disconnect()
}
