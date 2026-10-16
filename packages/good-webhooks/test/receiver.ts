import { once } from 'node:events'
import { createServer, type RequestListener, type Server } from 'node:http'

const servers: Server[] = []

/** Start a loopback receiver on a free port. Pair with closeReceivers() in afterEach. */
export async function startReceiver(
  handler: RequestListener,
): Promise<{ url: string; server: Server }> {
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`, server }
}

export async function closeReceivers(): Promise<void> {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
