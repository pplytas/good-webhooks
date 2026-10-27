import { describe, expect, it, vi } from 'vitest'
import {
  isReservedHeaderName,
  MAX_ENDPOINT_HEADER_CHARACTERS,
  RESERVED_HEADER_NAMES,
  TRANSPORT_HEADER_NAMES,
  validateEndpointHeaders,
} from '../src/management/headers.js'
import { createManagement } from '../src/management/index.js'
import type { ManagementRepository } from '../src/management/types.js'

const invalid = expect.objectContaining({ code: 'INVALID_INPUT' })

describe('endpoint header validation', () => {
  it('copies valid headers and keeps the caller casing', () => {
    const input = { 'X-Api-Key': 'secret', authorization: 'Bearer a\tb', 'x-latin': 'café' }
    const copy = validateEndpointHeaders(input)
    expect(copy).toEqual(input)
    expect(copy).not.toBe(input)
    expect(validateEndpointHeaders({})).toEqual({})
    expect(validateEndpointHeaders(Object.assign(Object.create(null), { a: 'b' }))).toEqual({
      a: 'b',
    })
  })

  it.each([null, 'x-api-key: 1', ['a'], new Map([['a', 'b']]), 5, new (class Headers {})()])(
    'rejects %s as a headers object',
    (value) => {
      expect(() => validateEndpointHeaders(value)).toThrow(invalid)
    },
  )

  it('accepts 20 headers and rejects 21', () => {
    const headers = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`x-h${index}`, 'v']))
    expect(Object.keys(validateEndpointHeaders(headers(20)))).toHaveLength(20)
    expect(() => validateEndpointHeaders(headers(21))).toThrow(invalid)
  })

  it.each(['', 'x'.repeat(101), 'bad header', 'x-ä', 'x:y', 'x(y)', 'x"y', 'x\ny'])(
    'rejects header name %j',
    (name) => {
      expect(() => validateEndpointHeaders({ [name]: 'value' })).toThrow(invalid)
    },
  )

  it('accepts every RFC 9110 token character and a 100-character name', () => {
    const name = "!#$%&'*+.^_`|~09AZaz-"
    expect(validateEndpointHeaders({ [name]: 'v' })).toEqual({ [name]: 'v' })
    expect(Object.keys(validateEndpointHeaders({ ['x'.repeat(100)]: 'v' }))).toHaveLength(1)
  })

  it.each([
    '',
    'x'.repeat(2049),
    'a\r\nInjected: yes',
    'a\nb',
    'a\rb',
    'a\0b',
    'a\u0001b',
    'a\u007fb',
    'a\u0085b',
    'a€b',
    5,
    null,
  ])('rejects header value %j', (value) => {
    expect(() => validateEndpointHeaders({ 'x-api-key': value })).toThrow(invalid)
  })

  it('accepts a 2047-character value with a one-character name', () => {
    expect(validateEndpointHeaders({ a: 'v'.repeat(2047) }).a).toHaveLength(2047)
  })

  it('caps names and values together at 2048 characters', () => {
    expect(MAX_ENDPOINT_HEADER_CHARACTERS).toBe(2048)
    // Ten names of 4 characters plus values of 200 characters: exactly 2048.
    const atCap = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        `x-h${index}`,
        'v'.repeat(index === 9 ? 208 : 200),
      ]),
    )
    expect(
      Object.entries(atCap).reduce((sum, [name, value]) => sum + name.length + value.length, 0),
    ).toBe(2048)
    expect(validateEndpointHeaders(atCap)).toEqual(atCap)
    expect(() => validateEndpointHeaders({ ...atCap, 'x-h9': 'v'.repeat(209) })).toThrow(
      expect.objectContaining({
        code: 'INVALID_INPUT',
        message: 'Endpoint header names and values may hold at most 2048 characters in total.',
      }),
    )
    // One long bearer token still fits.
    const bearer = `Bearer ${'t'.repeat(2048 - 'authorization'.length - 'Bearer '.length)}`
    expect(validateEndpointHeaders({ authorization: bearer }).authorization).toBe(bearer)
    expect(() => validateEndpointHeaders({ a: 'v'.repeat(2048) })).toThrow(invalid)
  })

  it('rejects names that repeat with different case', () => {
    expect(() => validateEndpointHeaders({ 'X-Api-Key': 'a', 'x-api-key': 'b' })).toThrow(invalid)
  })

  it.each([
    'webhook-id',
    'Webhook-Signature',
    'WEBHOOK-TIMESTAMP',
    'webhook-anything',
    'Content-Type',
    'user-agent',
    'Host',
    'content-length',
    'Connection',
    'transfer-encoding',
    'upgrade',
    'expect',
    'Proxy-Authorization',
    'proxy-connection',
    'trailer',
    'TE',
  ])('rejects reserved name %s', (name) => {
    expect(isReservedHeaderName(name)).toBe(true)
    expect(() => validateEndpointHeaders({ [name]: 'value' })).toThrow(invalid)
  })

  it('allows names that only resemble reserved ones', () => {
    for (const name of ['webhook', 'x-webhook-id', 'authorization', 'content-encoding'])
      expect(isReservedHeaderName(name)).toBe(false)
  })

  it('shares one reserved list with the transport', () => {
    for (const name of TRANSPORT_HEADER_NAMES) expect(RESERVED_HEADER_NAMES.has(name)).toBe(true)
    expect([...RESERVED_HEADER_NAMES].sort()).toEqual(
      [...TRANSPORT_HEADER_NAMES, 'content-type', 'user-agent'].sort(),
    )
  })
})

describe('endpoint headers in management input', () => {
  function setup() {
    const repository: ManagementRepository = {
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      create: vi.fn(async () => {
        throw new Error('not reached')
      }),
      update: vi.fn(async () => null),
    }
    const scopeExists = vi.fn(async () => true)
    const management = createManagement({
      repository,
      eventTypes: ['order.created'],
      cipher: { encrypt: async (value) => value, decrypt: async (value) => value },
      scopeExists,
    })
    return { management, repository, scopeExists }
  }
  const input = { url: 'https://example.com/hook', eventTypes: ['order.created'] }

  it('rejects invalid headers on create and update before any asynchronous work', async () => {
    const { management, repository, scopeExists } = setup()
    for (const headers of [{ 'webhook-id': 'x' }, { 'x-a': '' }, 'x', [] as unknown]) {
      const create = management.create(null, {
        ...input,
        headers: headers as Record<string, string>,
      })
      const update = management.update(null, 'endpoint', {
        headers: headers as Record<string, string>,
      })
      expect(scopeExists).not.toHaveBeenCalled()
      await expect(create).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      await expect(update).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    expect(repository.get).not.toHaveBeenCalled()
  })

  it('snapshots caller headers before asynchronous work', async () => {
    const { management, repository } = setup()
    const headers: Record<string, string> = { 'x-api-key': 'original' }
    vi.mocked(repository.create).mockImplementation(async (_scope, endpoint) => ({
      ...endpoint,
      id: 'endpoint',
    }))
    const creating = management.create(null, { ...input, headers })
    headers['x-api-key'] = 'changed'
    headers['webhook-id'] = 'spoofed'
    const { endpoint } = await creating
    expect(endpoint.headers).toEqual({ 'x-api-key': 'original' })
  })
})
