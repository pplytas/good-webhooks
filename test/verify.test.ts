import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { generateSecret, signWebhook } from '../src/crypto.js'
import { parseWebhook, WebhookError } from '../src/verify.js'

const secret = generateSecret()
const now = new Date('2026-10-06T12:00:00.000Z')
const timestamp = now.getTime() / 1000
const envelope = {
  id: 'event_123',
  type: 'invoice.paid',
  occurredAt: '2020-01-01T00:00:00.000Z',
  data: { invoiceId: 'inv_1', amount: 4200 },
}
const events = {
  'invoice.paid': z.object({ invoiceId: z.string(), amount: z.number().int().nonnegative() }),
}
function signed(body: string | Uint8Array, id = envelope.id) {
  const signature = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
    .update(`${id}.${timestamp}.`)
    .update(body)
    .digest('base64')
  return {
    body,
    secret,
    now,
    events,
    headers: {
      'webhook-id': id,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': `v1,${signature}`,
    },
  }
}
const request = () => signed(JSON.stringify(envelope))
const invalid = { code: 'PAYLOAD_INVALID' }

describe('typed receiver parsing', () => {
  it('accepts strings and byte arrays with both header representations and old publication times', async () => {
    for (const body of [JSON.stringify(envelope), Buffer.from(JSON.stringify(envelope))]) {
      const input = signed(body)
      for (const headers of [input.headers, new Headers(input.headers)]) {
        await expect(parseWebhook({ ...input, headers })).resolves.toEqual(envelope)
      }
    }
  })

  it('supports overlapping receiver and sender secrets', async () => {
    const next = generateSecret()
    const body = JSON.stringify(envelope)
    const headers = signWebhook({ id: envelope.id, timestamp, body, secrets: [secret, next] })
    await expect(
      parseWebhook({ ...request(), headers, secret: [generateSecret(), next] }),
    ).resolves.toEqual(envelope)
  })

  it('awaits the selected validator and returns decoded output once', async () => {
    const validate = vi.fn(async (value: unknown) => {
      const data = events['invoice.paid'].parse(value)
      return { value: { ...data, amount: data.amount / 100, date: new Date(now) } }
    })
    const schema: StandardSchemaV1<unknown, typeof envelope.data & { date: Date }> = {
      '~standard': { version: 1, vendor: 'test', validate },
    }
    const event = await parseWebhook({
      ...request(),
      events: { 'invoice.paid': schema },
    })
    expect(event.data).toEqual({ invoiceId: 'inv_1', amount: 42, date: now })
    expect(event.data.date).toBeInstanceOf(Date)
    expect(validate).toHaveBeenCalledTimes(1)
  })

  it('supports asynchronous Zod output without validating the output again', async () => {
    const event = await parseWebhook({
      ...request(),
      events: {
        'invoice.paid': events['invoice.paid'].transform(async (data) => ({
          amount: data.amount / 100,
        })),
      },
    })
    expect(event.data).toEqual({ amount: 42 })
  })

  it('omits unknown envelope fields and leaves payload field handling to the schema', async () => {
    const input = signed(
      JSON.stringify({ ...envelope, extra: 'ignored', data: { ...envelope.data, extra: 'strip' } }),
    )
    await expect(parseWebhook(input)).resolves.toEqual(envelope)
    await expect(
      parseWebhook({ ...input, events: { 'invoice.paid': events['invoice.paid'].strict() } }),
    ).rejects.toMatchObject(invalid)
  })

  it('rejects invalid signatures before parsing or calling a validator', async () => {
    const validate = vi.fn(() => ({ value: 'unused' }))
    const schema = { '~standard': { version: 1 as const, vendor: 'test', validate } }
    await expect(
      parseWebhook({ ...request(), body: '{', events: { 'invoice.paid': schema } }),
    ).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' })
    expect(validate).not.toHaveBeenCalled()
    await expect(
      parseWebhook({ ...request(), now: new Date(now.getTime() + 301_000) }),
    ).rejects.toMatchObject({ code: 'SIGNATURE_EXPIRED' })
  })

  it('requires matching authenticated header and body identities', async () => {
    await expect(
      parseWebhook(signed(JSON.stringify(envelope), 'different_id')),
    ).rejects.toMatchObject(invalid)
  })

  it('uses one header snapshot and copies mutable input bytes before reading headers', async () => {
    const input = signed(Buffer.from(JSON.stringify(envelope)))
    let reads = 0
    const headers = { ...input.headers }
    Object.defineProperty(headers, 'webhook-id', {
      enumerable: true,
      get() {
        reads++
        ;(input.body as Uint8Array).fill(0)
        return reads === 1 ? envelope.id : 'changed'
      },
    })
    await expect(parseWebhook({ ...input, headers })).resolves.toEqual(envelope)
    expect(reads).toBe(1)
  })

  it('preserves identity during asynchronous validation', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const input = {
      ...request(),
      events: {
        'invoice.paid': events['invoice.paid'].transform(async (data) => {
          await gate
          return data
        }),
      },
    }
    const pending = parseWebhook(input)
    input.body = '{}'
    input.headers['webhook-id'] = 'changed'
    release()
    await expect(pending).resolves.toEqual(envelope)
  })

  it.each(['', '{', 'null', '[]', '1', '"text"'])(
    'rejects malformed or non-object JSON: %j',
    async (body) => {
      await expect(parseWebhook(signed(body))).rejects.toMatchObject(invalid)
    },
  )

  it.each(['id', 'type', 'occurredAt', 'data'])('requires its own %s field', async (key) => {
    const body: Record<string, unknown> = { ...envelope }
    delete body[key]
    await expect(
      parseWebhook({ ...signed(JSON.stringify(body)), events: { 'invoice.paid': z.unknown() } }),
    ).rejects.toMatchObject(invalid)
  })

  it.each([null, 123, '', 'unknown', 'toString', 'constructor'])(
    'rejects an unknown or invalid event name: %j',
    async (type) => {
      await expect(
        parseWebhook(signed(JSON.stringify({ ...envelope, type }))),
      ).rejects.toMatchObject(invalid)
    },
  )

  it('accepts an explicitly registered own constructor name, but not an inherited schema', async () => {
    const input = signed(JSON.stringify({ ...envelope, type: 'constructor' }))
    await expect(
      parseWebhook({ ...input, events: { constructor: events['invoice.paid'] } }),
    ).resolves.toMatchObject({ type: 'constructor', data: envelope.data })
    await expect(
      parseWebhook({ ...request(), events: Object.create(events) }),
    ).rejects.toMatchObject(invalid)
  })

  it.each([
    null,
    0,
    'today',
    '2026-02-30T00:00:00.000Z',
    '2026-10-06',
    '2026-10-06T12:00:00+00:00',
  ])('rejects noncanonical or invalid occurrence time: %j', async (occurredAt) => {
    await expect(
      parseWebhook(signed(JSON.stringify({ ...envelope, occurredAt }))),
    ).rejects.toMatchObject(invalid)
  })

  it('reports schema issues without exposing their messages or input', async () => {
    const input = signed(JSON.stringify({ ...envelope, data: 'sensitive-payload' }))
    const result = parseWebhook({
      ...input,
      events: { 'invoice.paid': z.string().refine(() => false, 'sensitive-payload') },
    })
    await expect(result).rejects.toMatchObject(invalid)
    await expect(result).rejects.not.toThrow('sensitive-payload')
  })

  it.each([
    new Error('decoder unavailable'),
    new WebhookError('PAYLOAD_INVALID', 'decoder threw'),
    new WebhookError('SIGNATURE_INVALID', 'decoder threw'),
  ])('keeps thrown validator failures distinct from request rejection', async (cause) => {
    const schema: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'test',
        async validate() {
          throw cause
        },
      },
    }
    const result = parseWebhook({ ...request(), events: { 'invoice.paid': schema } })
    await expect(result).rejects.toMatchObject({ name: 'Error', cause })
    await expect(result).rejects.not.toBeInstanceOf(WebhookError)
  })

  it('reports trusted configuration failures separately', async () => {
    await expect(parseWebhook({ ...request(), secret: 'wrong-format' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    await expect(parseWebhook({ ...request(), events: null as never })).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    })
    await expect(
      parseWebhook({ ...request(), events: { 'invoice.paid': {} } as never }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
  })

  it('accepts maximum-sized producer payloads, including UTF-8 and escaped content', async () => {
    for (const data of ['a'.repeat(262142), 'é'.repeat(131071), '\u0000'.repeat(43690)]) {
      const body = JSON.stringify({ ...envelope, type: 'a'.repeat(120), data })
      await expect(
        parseWebhook({ ...signed(body), events: { ['a'.repeat(120)]: z.string() } }),
      ).resolves.toMatchObject({ data })
    }
  })

  it('rejects excessive raw bodies before signature work', async () => {
    await expect(parseWebhook({ ...request(), body: 'a'.repeat(524289) })).rejects.toMatchObject(
      invalid,
    )
    await expect(parseWebhook({ ...request(), body: Buffer.alloc(524289) })).rejects.toMatchObject(
      invalid,
    )
  })

  it('rejects excessive payload size, depth, and non-finite numbers before schema execution', async () => {
    const validate = vi.fn((value: unknown) => ({ value }))
    const schema = { '~standard': { version: 1 as const, vendor: 'test', validate } }
    const prefix = JSON.stringify(envelope).replace(/"data":.*$/, '"data":')
    const inputs = [
      JSON.stringify({ ...envelope, data: 'a'.repeat(262143) }),
      prefix + '['.repeat(65) + '0' + ']'.repeat(65) + '}',
      prefix + '1e400}',
    ]
    for (const body of inputs) {
      await expect(
        parseWebhook({ ...signed(body), events: { 'invoice.paid': schema } }),
      ).rejects.toMatchObject(invalid)
    }
    expect(validate).not.toHaveBeenCalled()
    const atDepthLimit = prefix + '['.repeat(64) + '0' + ']'.repeat(64) + '}'
    await expect(
      parseWebhook({ ...signed(atDepthLimit), events: { 'invoice.paid': schema } }),
    ).resolves.toBeDefined()
  })

  it('verifies bytes before rejecting malformed UTF-8 or a byte-order mark', async () => {
    for (const body of [
      Buffer.from([0xff]),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(envelope))]),
    ]) {
      await expect(parseWebhook(signed(body))).rejects.toMatchObject(invalid)
      await expect(
        parseWebhook({ ...signed(body), secret: generateSecret() }),
      ).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' })
    }
  })
})
