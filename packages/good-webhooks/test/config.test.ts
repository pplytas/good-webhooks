import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { resolveConfig } from '../src/config.js'
import { toJson } from '../src/json.js'
import type { EndpointSource } from '../src/management/types.js'
import type { Database } from '../src/types.js'

const database = { query: vi.fn(), connect: vi.fn() } as unknown as Database
const source: EndpointSource = {
  matchRecipients: vi.fn(async () => []),
  resolveEndpoint: vi.fn(async () => ({ status: 'deleted' as const })),
}
const options = {
  database,
  source,
  events: { 'order.created': z.object({ id: z.string() }) },
}

describe('configuration', () => {
  it('does not connect and copies mutable configuration', () => {
    const delays = [50, 100]
    const resolved = resolveConfig({ ...options, retry: { delaysMs: delays } })
    delays[0] = 999
    expect(resolved.retryDelaysMs).toEqual([50, 100])
    expect(resolved.source).toBe(source)
    expect(source.matchRecipients).not.toHaveBeenCalled()
    expect(source.resolveEndpoint).not.toHaveBeenCalled()
    expect(database.connect).not.toHaveBeenCalled()
  })
  it('reserves event names under good-webhooks.', () => {
    expect(() =>
      resolveConfig({ ...options, events: { 'good-webhooks.test': z.object({}) } }),
    ).toThrow(/reserved/)
  })
  it('retries for about 28 hours by default, within the default age limit', () => {
    const { retryDelaysMs, maxAgeMs } = resolveConfig(options)
    expect(retryDelaysMs).toEqual([
      5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 36_000_000,
    ])
    expect(maxAgeMs).toBe(172_800_000)
    // Even with the full 20% jitter on every delay, the last retry fits in the window.
    const total = retryDelaysMs.reduce((sum, delay) => sum + delay, 0)
    expect(total * 1.2).toBeLessThan(maxAgeMs)
  })
  it('rejects invalid concurrency, retry values, and leases', () => {
    expect(() => resolveConfig({ ...options, delivery: { concurrency: 0 } })).toThrow(/concurrency/)
    expect(() => resolveConfig({ ...options, retry: { delaysMs: [-1] } })).toThrow(/delaysMs/)
    expect(resolveConfig(options).respectRetryAfter).toBe(true)
    expect(() =>
      resolveConfig({ ...options, retry: { respectRetryAfter: 'yes' as unknown as boolean } }),
    ).toThrow(/respectRetryAfter/)
    expect(() => resolveConfig({ ...options, delivery: { leaseMs: 1000 } })).toThrow(/leaseMs/)
    expect(() => resolveConfig({ ...options, retentionMs: 1000 })).toThrow(/retentionMs/)
    expect(() => resolveConfig({ ...options, events: {} })).toThrow(/event/)
    expect(() => resolveConfig({ ...options, source: {} as EndpointSource })).toThrow(/source/)
  })
})

describe('automatic pause and hooks configuration', () => {
  it('turns automatic pauses on by default and validates their options', () => {
    expect(resolveConfig(options).endpointHealth).toEqual({
      pauseAfterMs: 432_000_000,
      pauseOnGone: true,
    })
    expect(resolveConfig({ ...options, endpointHealth: false }).endpointHealth).toBeNull()
    expect(
      resolveConfig({ ...options, endpointHealth: { pauseAfterMs: 3_600_000, pauseOnGone: false } })
        .endpointHealth,
    ).toEqual({ pauseAfterMs: 3_600_000, pauseOnGone: false })
    for (const endpointHealth of [
      { pauseAfterMs: 59_999 },
      { pauseAfterMs: 2_592_000_001 },
      { pauseAfterMs: 1.5 },
      { pauseOnGone: 'yes' },
      true,
    ])
      expect(() => resolveConfig({ ...options, endpointHealth: endpointHealth as false })).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIG' }),
      )
  })

  it('accepts optional hook functions only', () => {
    const onAttempt = vi.fn()
    expect(resolveConfig({ ...options, hooks: { onAttempt } }).hooks).toEqual({ onAttempt })
    expect(resolveConfig(options).hooks).toEqual({})
    for (const hooks of [{ onAttempt: 'log' }, 'hooks'])
      expect(() => resolveConfig({ ...options, hooks: hooks as {} })).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIG' }),
      )
  })
})

describe('JSON payloads', () => {
  it('canonicalizes property order and preserves __proto__ as data', () => {
    const data = JSON.parse('{"b":1,"__proto__":{"x":2},"a":3}')
    expect(JSON.stringify(toJson(data))).toBe('{"__proto__":{"x":2},"a":3,"b":1}')
    expect({}).not.toHaveProperty('x')
  })
  it('rejects values that JSON would silently change', () => {
    for (const value of [NaN, Infinity, undefined, { x: undefined }, new Date(), [1, , 2], 1n]) {
      expect(() => toJson(value)).toThrow()
    }
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => toJson(cycle)).toThrow()
    expect(() => toJson('x'.repeat(262145))).toThrow(/256 KiB/)
  })
})
