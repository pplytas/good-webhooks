import { createApplication } from './application.ts'
import { readConfig } from './config.ts'
import { createRuntime } from './runtime.ts'
import { closeServer, installShutdown } from './http.ts'

const runtime = createRuntime(readConfig())
try {
  await runtime.webhooks.check()
  const server = createApplication(runtime).listen(runtime.config.appPort, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  console.log(`Shop ready at http://127.0.0.1:${runtime.config.appPort}`)
  installShutdown(async () => {
    await closeServer(server)
    await runtime.pool.end()
  })
  runtime.pool.on('error', (error) => {
    console.error('Shop database connection failed:', error.message)
    process.kill(process.pid, 'SIGTERM')
    process.exitCode = 1
  })
} catch (error) {
  console.error('Shop failed:', error instanceof Error ? error.message : 'unknown error')
  await runtime.pool.end()
  process.exitCode = 1
}
