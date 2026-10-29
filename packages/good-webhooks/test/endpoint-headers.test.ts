import { describe, expect, it, vi } from 'vitest'
import {
  isReservedHeaderName,
  MAX_ENDPOINT_HEADER_BYTES,
  RESERVED_HEADER_NAMES,
  TRANSPORT_HEADER_NAMES,
  validateEndpointHeaders,
} from '../src/management/headers.js'
import { createManagement } from '../src/management/index.js'
import type { ManagementRepository, StoredEndpoint } from '../src/management/types.js'

const invalid = expect.objectContaining({ code: 'INVALID_INPUT' })

describe('endpoint header validation', () => {
  it('copies valid headers and keeps the caller casing', () => {
    const input = { 'X-Api-Key': 'secret', authorization: 'Bearer a\tb', 'x-text': ' "a\\b" ~ ' }
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

  it.each([
    ['x:y', 'Header x:y must be an HTTP token of 1 to 100 characters.'],
    ['', 'Header "" must be an HTTP token of 1 to 100 characters.'],
    ['bad header', 'Header "bad header" must be an HTTP token of 1 to 100 characters.'],
    ['x\ny', 'Header "x\\ny" must be an HTTP token of 1 to 100 characters.'],
    ['x'.repeat(101), `Header "${'x'.repeat(99)} must be an HTTP token of 1 to 100 characters.`],
  ])('names the invalid header %j in the error', (name, message) => {
    expect(() => validateEndpointHeaders({ [name]: 'value' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT', message }),
    )
  })

  it('accepts every RFC 9110 token character and a 100-character name', () => {
    const name = "!#$%&'*+.^_`|~09AZaz-"
    expect(validateEndpointHeaders({ [name]: 'v' })).toEqual({ [name]: 'v' })
    expect(Object.keys(validateEndpointHeaders({ ['x'.repeat(100)]: 'v' }))).toHaveLength(1)
  })

  it.each([
    '',
    'a\r\nInjected: yes',
    'a\nb',
    'a\rb',
    'a\0b',
    'a\u0001b',
    'a\u007fb',
    'a\u0085b',
    'a\u00a0b',
    'café',
    'a€b',
    5,
    null,
  ])('rejects header value %j', (value) => {
    expect(() => validateEndpointHeaders({ 'x-api-key': value })).toThrow(invalid)
  })

  it('rejects a value with é, which would change bytes on the wire', () => {
    expect(() => validateEndpointHeaders({ 'x-name': 'café' })).toThrow(
      expect.objectContaining({
        code: 'INVALID_INPUT',
        message: 'Header x-name must have a nonempty value of visible ASCII, spaces, and tabs.',
      }),
    )
  })

  describe('total size as UTF-8 JSON', () => {
    const bytes = (headers: Record<string, string>) =>
      new TextEncoder().encode(JSON.stringify(headers)).length
    const tooLarge = expect.objectContaining({
      code: 'INVALID_INPUT',
      message: 'Endpoint headers may hold at most 2048 bytes as JSON.',
    })

    it('accepts exactly 2048 bytes and rejects 2049', () => {
      expect(MAX_ENDPOINT_HEADER_BYTES).toBe(2048)
      // {"a":"…"} adds 8 bytes around the value.
      const atCap = { a: 'v'.repeat(2040) }
      expect(bytes(atCap)).toBe(2048)
      expect(validateEndpointHeaders(atCap)).toEqual(atCap)
      const over = { a: 'v'.repeat(2041) }
      expect(bytes(over)).toBe(2049)
      expect(() => validateEndpointHeaders(over)).toThrow(tooLarge)
      // Several headers count their commas and quotes too.
      const several = Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [`x-h${index}`, 'v'.repeat(195)]),
      )
      expect(bytes(several)).toBe(2051)
      expect(() => validateEndpointHeaders(several)).toThrow(tooLarge)
    })

    it('counts escaped quotes and backslashes at their JSON size', () => {
      // Each " and \ escapes to two bytes: 1020 characters, 2040 bytes.
      for (const value of ['"'.repeat(1020), '\\'.repeat(1020), '"\\'.repeat(510)]) {
        expect(value).toHaveLength(1020)
        expect(bytes({ a: value })).toBe(2048)
        expect(validateEndpointHeaders({ a: value }).a).toBe(value)
        expect(() => validateEndpointHeaders({ a: `${value}v` })).toThrow(tooLarge)
      }
    })

    it('fits one full-length bearer token', () => {
      // {"authorization":"…"} adds 20 bytes around the value.
      const bearer = `Bearer ${'t'.repeat(2048 - 20 - 'Bearer '.length)}`
      expect(bytes({ authorization: bearer })).toBe(2048)
      expect(validateEndpointHeaders({ authorization: bearer }).authorization).toBe(bearer)
    })
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

describe('stored endpoint headers', () => {
  function management(encryptedHeaders: string) {
    const row: StoredEndpoint = {
      id: 'endpoint',
      url: 'https://example.com/hook',
      description: null,
      eventTypes: ['order.created'],
      status: 'active',
      pauseReason: null,
      revision: 0,
      encryptedSecret: 'whsec_unused',
      previousEncryptedSecret: null,
      previousSecretExpiresAt: null,
      encryptedHeaders,
      createdAt: new Date('2026-10-27T00:00:00Z'),
      updatedAt: new Date('2026-10-27T00:00:00Z'),
    }
    const repository: ManagementRepository = {
      list: async () => [row],
      get: async () => row,
      create: async () => row,
      update: async () => null,
    }
    // Identity cipher: the stored blob is the plaintext JSON.
    return createManagement({
      repository,
      eventTypes: ['order.created'],
      cipher: { encrypt: async (value) => value, decrypt: async (value) => value },
    })
  }

  it.each(['not json', 'null', '{"a":1}', '["a"]', '"a"'])(
    'reports the unreadable blob %s as INVALID_CONFIG with a cause',
    async (blob) => {
      const error = await management(blob)
        .get(null, 'endpoint')
        .catch((reason: unknown) => reason)
      expect(error).toMatchObject({
        code: 'INVALID_CONFIG',
        message: 'Stored endpoint headers could not be read.',
      })
      expect((error as Error).cause).toBeInstanceOf(Error)
      await expect(management(blob).source.resolveEndpoint(null, 'endpoint')).rejects.toMatchObject(
        { code: 'INVALID_CONFIG' },
      )
    },
  )

  it('reads stored headers by shape only, so older rows survive stricter input rules', async () => {
    const stored = { 'webhook-legacy': 'kept', 'x-a': 'b' }
    expect((await management(JSON.stringify(stored)).get(null, 'endpoint')).headers).toEqual(stored)
  })
})
