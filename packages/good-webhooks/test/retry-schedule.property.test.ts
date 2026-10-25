import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { z } from 'zod'
import { resolveConfig } from '../src/config.js'
import { parseRetryAfter } from '../src/transport.js'
import type { EndpointSource } from '../src/management/types.js'
import type { Database } from '../src/types.js'

const MAX_RETRY_AFTER_MS = 31_536_000_000
const MAX_EPOCH_MS = 4_000_000_000_000

const database = { query: vi.fn(), connect: vi.fn() } as unknown as Database
const source: EndpointSource = {
  matchRecipients: vi.fn(async () => []),
  resolveEndpoint: vi.fn(async () => ({ status: 'deleted' as const })),
}

function resolve(delaysMs: readonly number[]) {
  return resolveConfig({
    database,
    source,
    events: { 'order.created': z.object({ id: z.string() }) },
    retry: { delaysMs: [...delaysMs] },
  })
}

describe('parseRetryAfter properties', () => {
  it('parses any zero-padded delta-seconds string as the clamped second count', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 * MAX_RETRY_AFTER_MS }),
        fc.integer({ min: 0, max: MAX_EPOCH_MS }),
        (seconds, now) => {
          const text = `${seconds}`.padStart(1 + (seconds % 3), '0')
          const wait = parseRetryAfter(text, now)
          expect(wait).toBe(Math.min(seconds * 1000, MAX_RETRY_AFTER_MS))
        },
      ),
    )
  })

  it('parses any future HTTP date as the clamped distance from now', () => {
    // HTTP dates only carry second granularity, so offsets are whole seconds
    const wholeSecondsMs = fc.integer({ min: 0, max: 60 * 31_536_000 }).map((s) => s * 1000)
    const wholeSecondsNow = fc.integer({ min: 0, max: MAX_EPOCH_MS }).map((s) => s * 1000)
    fc.assert(
      fc.property(wholeSecondsMs, wholeSecondsNow, (offsetMs, now) => {
        const header = new Date(now + offsetMs).toUTCString()
        const wait = parseRetryAfter(header, now)
        expect(wait).toBe(Math.min(offsetMs, MAX_RETRY_AFTER_MS))
      }),
    )
  })

  it('clamps past HTTP dates to zero instead of a negative wait', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_RETRY_AFTER_MS }),
        fc.integer({ min: 0, max: MAX_EPOCH_MS }),
        (pastMs, now) => {
          const header = new Date(now - pastMs).toUTCString()
          expect(parseRetryAfter(header, now)).toBe(0)
        },
      ),
    )
  })

  it('is monotonic for future HTTP dates', () => {
    const wholeSecondsMs = fc.integer({ min: 0, max: 31_536_000 }).map((s) => s * 1000)
    const wholeSecondsNow = fc.integer({ min: 0, max: MAX_EPOCH_MS }).map((s) => s * 1000)
    fc.assert(
      fc.property(wholeSecondsMs, wholeSecondsMs, wholeSecondsNow, (a, b, now) => {
        const [sooner, later] = a <= b ? [a, b] : [b, a]
        const waitSooner = parseRetryAfter(new Date(now + sooner).toUTCString(), now)
        const waitLater = parseRetryAfter(new Date(now + later).toUTCString(), now)
        expect(waitSooner).not.toBeNull()
        expect(waitLater).not.toBeNull()
        expect(waitLater!).toBeGreaterThanOrEqual(waitSooner!)
      }),
    )
  })

  it('never returns a wait outside [0, MAX] for arbitrary input', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }),
        fc.integer({ min: 0, max: MAX_EPOCH_MS }),
        (value, now) => {
          const wait = parseRetryAfter(value, now)
          if (wait !== null) {
            expect(wait).toBeGreaterThanOrEqual(0)
            expect(wait).toBeLessThanOrEqual(MAX_RETRY_AFTER_MS)
          }
        },
      ),
    )
  })
})

describe('retry schedule properties', () => {
  const validDelay = fc.integer({ min: 1, max: 86_400_000 })
  const invalidDelay = fc.oneof(
    fc.constantFrom(0, 86_400_001, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY),
    fc.integer({ min: 86_400_001, max: 1e12 }),
  )

  it('accepts every schedule of up to 20 positive day-scale delays and copies it', () => {
    fc.assert(
      fc.property(fc.array(validDelay, { minLength: 1, maxLength: 20 }), (delays) => {
        const snapshot = [...delays]
        const resolved = resolve(delays)
        delays[0] = 1
        expect(resolved.retryDelaysMs).toEqual(snapshot)
      }),
    )
  })

  it('rejects any schedule containing an out-of-range delay', () => {
    fc.assert(
      fc.property(
        fc.array(validDelay, { minLength: 0, maxLength: 19 }),
        invalidDelay,
        fc.nat(19),
        (prefix, invalid, insertAt) => {
          const tail = prefix.slice(0, Math.max(0, 20 - insertAt - 1))
          const delays = [...prefix.slice(0, insertAt), invalid, ...tail]
          expect(() => resolve(delays)).toThrow(/retry\.delaysMs/)
        },
      ),
    )
  })

  it('rejects schedules longer than 20 delays', () => {
    fc.assert(
      fc.property(fc.array(validDelay, { minLength: 21, maxLength: 30 }), (delays) => {
        expect(() => resolve(delays)).toThrow(/retry\.delaysMs/)
      }),
    )
  })
})
