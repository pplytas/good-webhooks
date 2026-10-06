import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  decryptSecret,
  encryptSecret,
  generateEncryptionKey,
  generateSecret,
  parseEncryptionKey,
  signWebhook,
  verifyWebhook,
} from '../src/crypto.js'

// Published interoperability vector from the independent Standard Webhooks implementation:
// https://github.com/standard-webhooks/standard-webhooks/blob/main/libraries/javascript/src/webhook.test.ts
const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
const id = 'msg_p5jXN8AQM9LWM0D4loKWxJek'
const body = '{"test": 2432232314}'
const timestamp = 1614265330
const now = new Date(timestamp * 1000)
const signature = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='
const headers = {
  'webhook-id': id,
  'webhook-timestamp': String(timestamp),
  'webhook-signature': signature,
}

describe('Standard Webhooks signatures', () => {
  it('matches an independent published test vector', () => {
    expect(signWebhook({ id, timestamp, body, secrets: [secret] })).toEqual(headers)
    expect(() => verifyWebhook({ body, headers, secret, now })).not.toThrow()
  })

  it('accepts native Headers and case-insensitive record names', () => {
    expect(() => verifyWebhook({ body, headers: new Headers(headers), secret, now })).not.toThrow()
    expect(() =>
      verifyWebhook({
        body,
        headers: {
          'Webhook-Id': id,
          'Webhook-Timestamp': String(timestamp),
          'Webhook-Signature': signature,
        },
        secret,
        now,
      }),
    ).not.toThrow()
  })

  it('supports overlapping sender and receiver secret rotation', () => {
    const next = generateSecret()
    const rotated = signWebhook({ id, timestamp, body, secrets: [secret, next] })
    expect(rotated['webhook-signature']?.split(' ')).toHaveLength(2)
    for (const accepted of [secret, next, [generateSecret(), next]]) {
      expect(() => verifyWebhook({ body, headers: rotated, secret: accepted, now })).not.toThrow()
    }
  })

  it('ignores unsupported signature versions without trusting them', () => {
    const unsupported = 'v9,' + Buffer.alloc(32, 1).toString('base64')
    expect(() =>
      verifyWebhook({
        body,
        headers: { ...headers, 'webhook-signature': `${unsupported} ${signature}` },
        secret,
        now,
      }),
    ).not.toThrow()
    expect(() =>
      verifyWebhook({
        body,
        headers: { ...headers, 'webhook-signature': unsupported },
        secret,
        now,
      }),
    ).toThrowError(expect.objectContaining({ code: 'SIGNATURE_INVALID' }))
  })

  it('preserves arbitrary raw bytes rather than decoding and re-encoding them', () => {
    const bytes = Uint8Array.from([0xff, 0x00, 0x80, 0x41])
    const expected = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
      .update(`${id}.${timestamp}.`)
      .update(bytes)
      .digest('base64')
    const binaryHeaders = { ...headers, 'webhook-signature': `v1,${expected}` }
    expect(() => verifyWebhook({ body: bytes, headers: binaryHeaders, secret, now })).not.toThrow()
    expect(() =>
      verifyWebhook({
        body: Buffer.from(bytes).toString('utf8'),
        headers: binaryHeaders,
        secret,
        now,
      }),
    ).toThrow()
  })

  it.each(['', body + ' ', '{"test":2432232314}', '{"test": 2432232315}'])(
    'rejects changed body bytes: %s',
    (changed) => {
      expect(() => verifyWebhook({ body: changed, headers, secret, now })).toThrowError(
        expect.objectContaining({ code: 'SIGNATURE_INVALID' }),
      )
    },
  )

  it.each(['webhook-id', 'webhook-timestamp', 'webhook-signature'])(
    'rejects a missing %s',
    (name) => {
      expect(() =>
        verifyWebhook({ body, headers: { ...headers, [name]: undefined }, secret, now }),
      ).toThrowError(expect.objectContaining({ code: 'SIGNATURE_INVALID' }))
    },
  )

  it.each([
    '1614265330junk',
    '1614265330.0',
    '01614265330',
    '-1',
    '1e9',
    ' 1614265330',
    '1614265330, 1614265330',
    '9007199254740992',
  ])('rejects noncanonical timestamp %s', (value) => {
    expect(() =>
      verifyWebhook({ body, headers: { ...headers, 'webhook-timestamp': value }, secret, now }),
    ).toThrowError(expect.objectContaining({ code: 'SIGNATURE_INVALID' }))
  })

  it.each([-301, 301])('rejects timestamps outside tolerance in either direction: %s', (offset) => {
    expect(() =>
      verifyWebhook({ body, headers, secret, now: new Date((timestamp + offset) * 1000) }),
    ).toThrowError(expect.objectContaining({ code: 'SIGNATURE_EXPIRED' }))
  })

  it.each([-300, 300])('accepts the exact tolerance boundary: %s', (offset) => {
    expect(() =>
      verifyWebhook({ body, headers, secret, now: new Date((timestamp + offset) * 1000) }),
    ).not.toThrow()
  })

  it('supports zero tolerance and rejects invalid verification configuration', () => {
    expect(() => verifyWebhook({ body, headers, secret, now, toleranceSeconds: 0 })).not.toThrow()
    for (const toleranceSeconds of [-1, 0.5, NaN, Infinity]) {
      expect(() => verifyWebhook({ body, headers, secret, now, toleranceSeconds })).toThrowError(
        expect.objectContaining({ code: 'INVALID_INPUT' }),
      )
    }
    expect(() => verifyWebhook({ body, headers, secret, now: new Date(NaN) })).toThrow()
  })

  it('rejects ambiguous duplicate headers', () => {
    expect(() =>
      verifyWebhook({ body, headers: { ...headers, 'Webhook-Id': id }, secret, now }),
    ).toThrow()
    const duplicate = new Headers(headers)
    duplicate.append('webhook-id', id)
    expect(() => verifyWebhook({ body, headers: duplicate, secret, now })).toThrow()
  })

  it.each([
    'v1,',
    'v1,AAAA',
    signature.slice(0, -1),
    signature + '=',
    signature + ',extra',
    'v1,' + 'A'.repeat(5000),
  ])('rejects malformed signatures', (value) => {
    expect(() =>
      verifyWebhook({ body, headers: { ...headers, 'webhook-signature': value }, secret, now }),
    ).toThrowError(expect.objectContaining({ code: 'SIGNATURE_INVALID' }))
  })

  it.each(['has.dot', 'has,comma', 'has whitespace', 'bad\r\nheader', '', 'x'.repeat(256)])(
    'rejects ambiguous IDs: %s',
    (value) => {
      expect(() => signWebhook({ id: value, timestamp, body, secrets: [secret] })).toThrow()
      expect(() =>
        verifyWebhook({ body, headers: { ...headers, 'webhook-id': value }, secret, now }),
      ).toThrow()
    },
  )

  it('rejects malformed secrets and empty or excessive rotation sets', () => {
    for (const value of [
      '',
      secret.slice(6),
      'whsec_AAAA',
      `${secret}=`,
      `whsec_${Buffer.alloc(65).toString('base64')}`,
    ]) {
      expect(() => signWebhook({ id, timestamp, body, secrets: [value] })).toThrowError(
        expect.objectContaining({ code: 'INVALID_INPUT' }),
      )
      expect(() => verifyWebhook({ body, headers, secret: value, now })).toThrow()
    }
    expect(() => signWebhook({ id, timestamp, body, secrets: [] })).toThrow()
    expect(() =>
      signWebhook({ id, timestamp, body, secrets: Array<string>(17).fill(secret) }),
    ).toThrow()
    expect(() => signWebhook({ id, timestamp: 1.5, body, secrets: [secret] })).toThrow()
  })
})

describe('secret encryption', () => {
  it('generates independent 256-bit signing and encryption keys', () => {
    const first = generateSecret()
    expect(first).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/)
    expect(first).not.toEqual(generateSecret())
    expect(parseEncryptionKey(generateEncryptionKey())).toHaveLength(32)
  })

  it('uses a distinct authenticated nonce for each encryption', () => {
    const key = parseEncryptionKey(generateEncryptionKey())
    const first = encryptSecret(secret, key)
    const second = encryptSecret(secret, key)
    expect(first).not.toEqual(second)
    expect(first).not.toContain(secret)
    expect(decryptSecret(first, key)).toBe(secret)
    expect(decryptSecret(second, key)).toBe(secret)
  })

  it('rejects tampered ciphertext, wrong keys, and malformed versions without echoing secrets', () => {
    const key = parseEncryptionKey(generateEncryptionKey())
    const encrypted = encryptSecret(secret, key)
    const parts = encrypted.split('.')
    const changed = [...parts]
    changed[3] = Buffer.alloc(Buffer.from(parts[3]!, 'base64').length).toString('base64')
    for (const value of [
      changed.join('.'),
      encrypted + '.extra',
      encrypted.replace(/^v1/, 'v2'),
      secret,
      'v1.AAAA.AAAA.AAAA',
    ]) {
      expect(() => decryptSecret(value, key)).toThrowError(
        expect.objectContaining({ code: 'INVALID_CONFIG' }),
      )
      try {
        decryptSecret(value, key)
      } catch (error) {
        expect(String(error)).not.toContain(secret)
      }
    }
    expect(() => decryptSecret(encrypted, parseEncryptionKey(generateEncryptionKey()))).toThrow()
  })

  it('validates key encoding and copies input keys', () => {
    const key = Uint8Array.from({ length: 32 }, () => 1)
    const parsed = parseEncryptionKey(key)
    key.fill(0)
    expect(parsed[0]).toBe(1)
    for (const value of [
      '',
      'AAAA',
      'A'.repeat(43),
      Buffer.alloc(31).toString('base64'),
      Buffer.alloc(33).toString('base64'),
      new Uint8Array(31),
    ]) {
      expect(() => parseEncryptionKey(value)).toThrowError(
        expect.objectContaining({ code: 'INVALID_CONFIG' }),
      )
    }
  })
})
