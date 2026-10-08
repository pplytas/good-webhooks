import { createContext } from './context.ts'
const context = await createContext()
const stop = new AbortController()
let deadline: NodeJS.Timeout | undefined
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    stop.abort()
    deadline ??= setTimeout(() => process.exit(1), 15_000).unref()
  })
try {
  console.log('Delivery worker running. Retry delays: 1s, 3s.')
  await context.delivery.worker.run({
    signal: stop.signal,
    pollIntervalMs: 250,
    shutdownGraceMs: 3_000,
  })
} catch (error) {
  console.error('Worker stopped after an error:', error)
  process.exitCode = 1
} finally {
  await context.pool.end()
  if (deadline) clearTimeout(deadline)
}
