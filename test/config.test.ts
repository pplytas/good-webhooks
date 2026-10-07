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
  it('rejects invalid concurrency, retry values, and leases', () => {
    expect(() => resolveConfig({ ...options, delivery: { concurrency: 0 } })).toThrow(/concurrency/)
    expect(() => resolveConfig({ ...options, retry: { delaysMs: [-1] } })).toThrow(/delaysMs/)
    expect(() => resolveConfig({ ...options, delivery: { leaseMs: 1000 } })).toThrow(/leaseMs/)
    expect(() => resolveConfig({ ...options, retentionMs: 1000 })).toThrow(/retentionMs/)
    expect(() => resolveConfig({ ...options, events: {} })).toThrow(/event/)
    expect(() => resolveConfig({ ...options, source: {} as EndpointSource })).toThrow(/source/)
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
