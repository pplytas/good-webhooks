import { createPool } from './database.ts'
import { createReceiver } from './receiver-app.ts'
import { config } from './config.ts'
import { installShutdown } from './http.ts'
const pool = createPool()
await pool.query('SELECT endpoint_id FROM billing_receivers LIMIT 0')
const server = createReceiver(pool).listen(config.RECEIVER_PORT, '127.0.0.1', () =>
  console.log(`Invoice receiver: ${config.receiverOrigin}`),
)
server.on('error', async (error) => {
  console.error(error.message)
  await pool.end()
  process.exitCode = 1
})
installShutdown(server, () => pool.end())
