import { createContext } from './context.ts'
import { createApp } from './app.ts'
import { config } from './config.ts'
import { installShutdown } from './http.ts'
const context = await createContext()
const server = createApp(context).listen(config.APP_PORT, '127.0.0.1', () =>
  console.log(`Billing app: ${config.appOrigin}`),
)
server.on('error', async (error) => {
  console.error(error.message)
  await context.pool.end()
  process.exitCode = 1
})
installShutdown(server, () => context.pool.end())
