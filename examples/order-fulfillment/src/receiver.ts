import { readConfig } from './config.ts'
import { createRuntime } from './runtime.ts'
import { createReceiver } from './receiver-app.ts'
import { closeServer, installShutdown } from './http.ts'

const runtime = createRuntime(readConfig())
try {
  // Runtime only checks prepared storage. Setup is the sole migration entrypoint.
  await runtime.pool.query(`SELECT singleton FROM ${runtime.table('warehouse_config')}`)
  const server = createReceiver(runtime).listen(runtime.config.receiverPort, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  console.log(`Warehouse ready at http://127.0.0.1:${runtime.config.receiverPort}`)
  installShutdown(async () => {
    await closeServer(server)
    await runtime.pool.end()
  })
  runtime.pool.on('error', (error) => {
    console.error('Warehouse database connection failed:', error.message)
    process.exitCode = 1
    process.kill(process.pid, 'SIGTERM')
  })
} catch (error) {
  console.error('Warehouse failed:', error instanceof Error ? error.message : 'unknown error')
  await runtime.pool.end()
  process.exitCode = 1
}
