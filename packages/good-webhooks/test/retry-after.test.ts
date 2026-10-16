import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createWebhooks } from '../src/index.js'
import { parseRetryAfter } from '../src/worker.js'
import { closeDatabase, pool, resetDatabase } from './db.js'

const servers: Server[] = []
let reply: { status: number; retryAfter?: string } = { status: 429 }

beforeEach(async () => {
  reply = { status: 429 }
  await resetDatabase()
})
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()))
})
afterAll(closeDatabase)

async function setup(respectRetryAfter?: boolean) {
  const server = createServer((_request, response) =>
    response
      .writeHead(
        reply.status,
        reply.retryAfter === undefined ? {} : { 'retry-after': reply.retryAfter },
      )
      .end(),
  )
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const app = createWebhooks({
    database: pool,
    encryptionKey: new Uint8Array(32).fill(7),
    events: { 'invoice.paid': z.object({ id: z.string() }) },
    allowLocalhost: true,
    retry: {
      delaysMs: [1000],
      maxAgeMs: 600_000,
      ...(respectRetryAfter === undefined ? {} : { respectRetryAfter }),
    },
  })
  await app.endpoints.create({
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`,
    eventTypes: ['invoice.paid'],
  })
  await app.publish({ type: 'invoice.paid', data: { id: 'inv_1' } })
  return app
}
/** Seconds until the next attempt, measured with the database clock. */
async function nextAttemptIn() {
  const { rows } = await pool.query(
    'SELECT status, extract(epoch FROM next_attempt_at - now())::float AS seconds FROM public.webhook_deliveries',
  )
  return rows[0] as { status: string; seconds: number }
}

describe('Retry-After', () => {
  const cases: [status: number, retryAfter: () => string, seconds: number][] = [
    [429, () => '120', 120],
    [503, () => new Date(Date.now() + 300_000).toUTCString(), 300],
  ]
  it.each(cases)(
    'waits as long as a %i response asks when that is longer than the schedule',
    async (status, retryAfter, seconds) => {
      reply = { status, retryAfter: retryAfter() }
      const app = await setup()
      expect((await app.worker.runOnce()).retried).toBe(1)
      const next = await nextAttemptIn()
      expect(next.seconds).toBeGreaterThan(seconds - 10)
      expect(next.seconds).toBeLessThan(seconds + 10)
    },
  )

  it('keeps the schedule for other statuses, shorter values, or when turned off', async () => {
    for (const [respect, status, retryAfter] of [
      [undefined, 500, '120'],
      [undefined, 429, '0'],
      [false, 429, '120'],
    ] as const) {
      await resetDatabase()
      reply = { status, retryAfter }
      const app = await setup(respect)
      await app.worker.runOnce()
      expect((await nextAttemptIn()).seconds).toBeLessThan(2)
    }
  })

  it('fails the delivery instead of waiting past the retry window', async () => {
    reply = { status: 429, retryAfter: '3600' }
    const app = await setup()
    expect((await app.worker.runOnce()).failed).toBe(1)
    expect((await nextAttemptIn()).status).toBe('failed')
  })

  it('parses delta-seconds and HTTP dates and ignores anything else', () => {
    const now = Date.parse('2026-10-16T12:00:00Z')
    expect(parseRetryAfter('120', now)).toBe(120_000)
    expect(parseRetryAfter(' 0 ', now)).toBe(0)
    expect(parseRetryAfter('Fri, 16 Oct 2026 12:02:00 GMT', now)).toBe(120_000)
    expect(parseRetryAfter('Fri, 16 Oct 2026 11:00:00 GMT', now)).toBe(0)
    expect(parseRetryAfter('99999999999', now)).toBe(31_536_000_000)
    for (const value of [undefined, '', '-5', '1.5', 'soon', '12abc'])
      expect(parseRetryAfter(value, now)).toBeNull()
  })
})
