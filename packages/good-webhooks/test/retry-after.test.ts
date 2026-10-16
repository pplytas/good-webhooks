import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createWebhooks } from '../src/index.js'
import { closeDatabase, pool, resetDatabase } from './db.js'
import { closeReceivers, startReceiver } from './receiver.js'

let reply: { status: number; retryAfter?: string } = { status: 429 }

beforeEach(async () => {
  reply = { status: 429 }
  await resetDatabase()
})
afterEach(closeReceivers)
afterAll(closeDatabase)

async function setup(respectRetryAfter?: boolean) {
  const { url } = await startReceiver((_request, response) =>
    response
      .writeHead(
        reply.status,
        reply.retryAfter === undefined ? {} : { 'retry-after': reply.retryAfter },
      )
      .end(),
  )
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
    url,
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
      // Retry-After gets the usual 0-20% jitter on top.
      expect(next.seconds).toBeLessThan(seconds * 1.2 + 10)
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
})
