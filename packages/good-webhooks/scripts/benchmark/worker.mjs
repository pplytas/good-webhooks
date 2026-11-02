import assert from 'node:assert/strict'
import { database, profile, webhooks } from './config.mjs'

assert(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required.')
assert(/^gw_bench_[a-f0-9]+$/.test(process.env.BENCHMARK_SCHEMA ?? ''))
assert(process.env.BENCHMARK_ENCRYPTION_KEY, 'BENCHMARK_ENCRYPTION_KEY is required.')

const stop = new AbortController()
const requestStop = () => stop.abort()
process.on('SIGTERM', requestStop)
const pool = database(process.env.TEST_DATABASE_URL)
pool.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
  stop.abort()
})
try {
  const app = webhooks(pool, process.env.BENCHMARK_SCHEMA, process.env.BENCHMARK_ENCRYPTION_KEY)
  await app.check()
  process.send({ ready: true })
  await app.worker.run({
    signal: stop.signal,
    pollIntervalMs: profile.pollIntervalMs,
    shutdownGraceMs: 1000,
  })
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await pool.end()
  process.off('SIGTERM', requestStop)
  process.disconnect()
}
