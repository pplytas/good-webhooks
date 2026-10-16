import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createWebhooks } from '../src/index.js'
import type { AttemptEvent, EndpointHealthOptions, EndpointPausedEvent } from '../src/types.js'
import { closeDatabase, pool, resetDatabase } from './db.js'

const events = { 'invoice.paid': z.object({ id: z.string() }) }
const scope = { type: 'user', id: 'owner' }
const servers: Server[] = []
let status = 500

beforeEach(async () => {
  status = 500
  await resetDatabase()
})
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
afterAll(closeDatabase)

async function receiver(): Promise<string> {
  const server = createServer((_request, response) => response.writeHead(status).end())
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`
}

function setup(endpointHealth?: false | EndpointHealthOptions) {
  const attempts: AttemptEvent[] = []
  const paused: EndpointPausedEvent[] = []
  const app = createWebhooks({
    database: pool,
    encryptionKey: new Uint8Array(32).fill(7),
    events,
    allowLocalhost: true,
    retry: { delaysMs: [10, 10, 10, 10], maxAgeMs: 60_000 },
    ...(endpointHealth === undefined ? {} : { endpointHealth }),
    hooks: {
      onAttempt: (event) => void attempts.push(event),
      onEndpointPaused: (event) => void paused.push(event),
    },
  })
  return { app, user: app.forScope(scope), attempts, paused }
}

async function attempt(app: ReturnType<typeof setup>['app']) {
  await pool.query(
    "UPDATE public.webhook_deliveries SET next_attempt_at=now()-interval '1 second' WHERE status='pending'",
  )
  return app.worker.runOnce()
}
async function failingSince() {
  return (await pool.query('SELECT failing_since FROM public.webhook_endpoint_state')).rows[0]
    ?.failing_since as Date | null
}
/** Move the start of the current failure window back, as if attempts had failed for days. */
async function backdate(days: number) {
  await pool.query(
    `UPDATE public.webhook_endpoint_state SET failing_since=failing_since-($1 * interval '1 day')`,
    [days],
  )
}

describe('automatic pause', () => {
  it('pauses an endpoint once every attempt has failed for the whole window', async () => {
    const { app, user, attempts, paused } = setup()
    const { endpoint } = await user.endpoints.create({
      url: await receiver(),
      eventTypes: ['invoice.paid'],
    })
    await user.publish({ type: 'invoice.paid', data: { id: 'inv_1' } })
    expect((await attempt(app)).retried).toBe(1)
    expect(await failingSince()).toBeInstanceOf(Date)
    expect((await user.endpoints.get(endpoint.id)).status).toBe('active')

    await backdate(4)
    await attempt(app)
    expect((await user.endpoints.get(endpoint.id)).status).toBe('active')

    await backdate(1)
    await attempt(app)
    expect(await user.endpoints.get(endpoint.id)).toMatchObject({
      status: 'paused',
      pauseReason: 'failing',
    })
    expect(paused).toEqual([{ scope, endpointId: endpoint.id, reason: 'failing' }])
    expect(attempts).toHaveLength(3)
    expect(attempts[0]).toMatchObject({
      scope,
      endpointId: endpoint.id,
      eventType: 'invoice.paid',
      attempt: 1,
      outcome: 'retry',
      responseStatus: 500,
      error: 'Receiver returned HTTP 500',
    })
    expect(attempts[0]!.durationMs).toBeGreaterThanOrEqual(0)

    // Paused work stays queued and nothing more is sent.
    await attempt(app)
    expect(attempts).toHaveLength(3)
    expect((await user.deliveries.list()).items[0]?.status).toBe('pending')
  })

  it('pauses immediately on HTTP 410 without deleting the endpoint', async () => {
    status = 410
    const { app, user, paused } = setup()
    const { endpoint } = await user.endpoints.create({
      url: await receiver(),
      eventTypes: ['invoice.paid'],
    })
    await user.publish({ type: 'invoice.paid', data: { id: 'inv_1' } })
    expect((await attempt(app)).failed).toBe(1)
    expect(await user.endpoints.get(endpoint.id)).toMatchObject({
      status: 'paused',
      pauseReason: 'gone',
    })
    expect(paused).toEqual([{ scope, endpointId: endpoint.id, reason: 'gone' }])
  })

  it('starts a new window after a success, an endpoint change, or a resume', async () => {
    const { app, user, paused } = setup()
    const url = await receiver()
    const { endpoint } = await user.endpoints.create({ url, eventTypes: ['invoice.paid'] })
    await user.publish({ type: 'invoice.paid', data: { id: 'inv_1' } })
    await attempt(app)
    status = 204
    await attempt(app)
    expect(await failingSince()).toBeNull()

    status = 500
    await user.publish({ type: 'invoice.paid', data: { id: 'inv_2' } })
    await attempt(app)
    await backdate(6)
    // The owner fixes something: the old failures no longer describe this endpoint.
    await user.endpoints.update(endpoint.id, { description: 'retried with a new proxy' })
    await attempt(app)
    expect((await user.endpoints.get(endpoint.id)).status).toBe('active')
    expect(Date.now() - (await failingSince())!.getTime()).toBeLessThan(60_000)

    await backdate(6)
    await attempt(app)
    expect((await user.endpoints.get(endpoint.id)).pauseReason).toBe('failing')
    await user.endpoints.resume(endpoint.id)
    await attempt(app)
    expect((await user.endpoints.get(endpoint.id)).status).toBe('active')
    expect(paused).toHaveLength(1)
  })

  it('never pauses when turned off, and can ignore 410 alone', async () => {
    status = 410
    const off = setup(false)
    await off.user.endpoints.create({ url: await receiver(), eventTypes: ['invoice.paid'] })
    await off.user.publish({ type: 'invoice.paid', data: { id: 'inv_1' } })
    await attempt(off.app)
    expect((await off.user.endpoints.list())[0]?.status).toBe('active')
    expect(await failingSince()).toBeNull()

    const failingOnly = setup({ pauseOnGone: false })
    await failingOnly.user.publish({ type: 'invoice.paid', data: { id: 'inv_2' } })
    await attempt(failingOnly.app)
    expect((await failingOnly.user.endpoints.list())[0]?.status).toBe('active')
    expect(failingOnly.paused).toEqual([])
  })

  it('does not count abandoned attempts', async () => {
    const { app, user } = setup()
    await user.endpoints.create({ url: await receiver(), eventTypes: ['invoice.paid'] })
    await user.publish({ type: 'invoice.paid', data: { id: 'inv_1' } })
    const controller = new AbortController()
    const sending = vi.fn()
    const server = servers[0]!
    server.removeAllListeners('request')
    server.on('request', () => {
      sending()
      controller.abort()
    })
    await app.worker.runOnce({ signal: controller.signal, shutdownGraceMs: 0 })
    expect(sending).toHaveBeenCalled()
    expect(
      (await pool.query('SELECT outcome FROM public.webhook_attempts')).rows.map((r) => r.outcome),
    ).toEqual(['abandoned'])
    expect(await failingSince()).toBeNull()
  })
})
