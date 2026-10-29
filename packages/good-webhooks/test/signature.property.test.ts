import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { generateSecret, signWebhook, verifyWebhook } from '../src/crypto.js'
import type { VerifyWebhookInput } from '../src/crypto.js'

const MAX_DATE_SECONDS = 8_640_000_000_000
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const ID_CHARS = Array.from({ length: 0x7e - 0x20 }, (_, n) =>
  String.fromCharCode(0x21 + n),
).filter((char) => char !== '.' && char !== ',')
const SECRETS = Array.from({ length: 16 }, () => generateSecret())

const SECRET = SECRETS[0]!
const ID = 'msg_2kz1'
const TIMESTAMP = 1_700_000_000
const BODY = '{"ok":true}'
const NOW = new Date(TIMESTAMP * 1000)
const VALID = signWebhook({ id: ID, timestamp: TIMESTAMP, body: BODY, secrets: [SECRET] })[
  'webhook-signature'
]!
const VALID_VALUE = VALID.slice('v1,'.length)

const id = fc.string({ unit: fc.constantFrom(...ID_CHARS), minLength: 1, maxLength: 255 })
const otherSignature = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => Buffer.from(bytes).toString('base64'))
  .filter((value) => value !== VALID_VALUE)

function headers(overrides: Record<string, unknown> = {}) {
  return {
    'webhook-id': ID,
    'webhook-timestamp': String(TIMESTAMP),
    'webhook-signature': VALID,
    ...overrides,
  } as VerifyWebhookInput['headers']
}

/** Returns 'accepted' or the WebhookError code. */
function verify(input: Partial<VerifyWebhookInput> = {}): string {
  try {
    verifyWebhook({ body: BODY, secret: SECRET, now: NOW, headers: headers(), ...input })
    return 'accepted'
  } catch (error) {
    return (error as { code: string }).code
  }
}

function signature(value: string): string {
  return verify({ headers: headers({ 'webhook-signature': value }) })
}

function decodes32(value: string): boolean {
  const bytes = Buffer.from(value, 'base64')
  return bytes.length === 32 && bytes.toString('base64') === value
}

describe('signature round trip properties', () => {
  it('verifies signWebhook output with any one of the signing secrets', () => {
    fc.assert(
      fc.property(
        id,
        fc.integer({ min: 0, max: MAX_DATE_SECONDS - 301 }),
        fc.string({ unit: 'grapheme', maxLength: 200 }),
        fc.integer({ min: 1, max: 16 }),
        fc.nat(),
        fc.integer({ min: -300_000, max: 300_999 }),
        (id, timestamp, body, count, pick, skewMs) => {
          const secrets = SECRETS.slice(0, count)
          const signed = signWebhook({ id, timestamp, body, secrets })
          const now = new Date(Math.max(0, timestamp * 1000 + skewMs))
          const input = { body, headers: signed, now }
          expect(() => verifyWebhook({ ...input, secret: secrets[pick % count]! })).not.toThrow()
          expect(() => verifyWebhook({ ...input, secret: generateSecret() })).toThrow(
            expect.objectContaining({ code: 'SIGNATURE_INVALID' }),
          )
        },
      ),
    )
  })
})

describe('signature header parsing properties', () => {
  it('rejects any single-character edit of the signature value', () => {
    const edited = fc
      .tuple(fc.nat(VALID_VALUE.length - 1), fc.constantFrom(...BASE64_CHARS, '='))
      .map(([at, char]) => VALID_VALUE.slice(0, at) + char + VALID_VALUE.slice(at + 1))
      .filter((value) => value !== VALID_VALUE && decodes32(value))
    fc.assert(
      fc.property(edited, (value) => {
        expect(signature(`v1,${value}`)).toBe('SIGNATURE_INVALID')
      }),
    )
  })

  it('ignores candidates that are not base64 of 32 bytes', () => {
    const invalidChar = fc
      .tuple(fc.nat(VALID_VALUE.length - 1), fc.constantFrom('-', '_', '!', '*', '#', '~', '.'))
      .map(([at, char]) => VALID_VALUE.slice(0, at) + char + VALID_VALUE.slice(at + 1))
    const wrongPadding = fc.constantFrom(
      VALID_VALUE.slice(0, -1),
      `${VALID_VALUE}=`,
      `${VALID_VALUE.slice(0, -1)}==`,
      `=${VALID_VALUE.slice(0, -1)}`,
    )
    const otherLength = fc
      .uint8Array({ minLength: 1, maxLength: 64 })
      .filter((bytes) => bytes.length !== 32)
      .map((bytes) => Buffer.from(bytes).toString('base64'))
    const candidates = fc.array(
      fc.oneof(invalidChar, wrongPadding, otherLength).map((value) => `v1,${value}`),
      { minLength: 1, maxLength: 20 },
    )
    fc.assert(
      fc.property(candidates, fc.nat(), (entries, at) => {
        expect(signature(entries.join(' '))).toBe('SIGNATURE_INVALID')
        const withValid = entries.toSpliced(at % (entries.length + 1), 0, VALID).join(' ')
        fc.pre(withValid.length <= 4096)
        expect(signature(withValid)).toBe('accepted')
      }),
    )
  })

  it('never accepts the correct signature under a missing or unknown version', () => {
    const entry = fc.constantFrom(
      `v0,${VALID_VALUE}`,
      `v1a,${VALID_VALUE}`,
      `V1,${VALID_VALUE}`,
      `v2,${VALID_VALUE}`,
      `,${VALID_VALUE}`,
      VALID_VALUE,
      `v1,${VALID_VALUE},extra`,
      `v1,${VALID_VALUE},`,
      `v1${VALID_VALUE}`,
    )
    fc.assert(
      fc.property(fc.array(entry, { minLength: 1, maxLength: 8 }), (entries) => {
        expect(signature(entries.join(' '))).toBe('SIGNATURE_INVALID')
      }),
    )
  })

  it('treats repeated v1 entries like a single entry', () => {
    const maxRepeats = Math.floor(4097 / (VALID.length + 1))
    fc.assert(
      fc.property(fc.integer({ min: 1, max: maxRepeats }), otherSignature, (count, other) => {
        expect(signature(Array(count).fill(VALID).join(' '))).toBe('accepted')
        expect(signature(Array(count).fill(`v1,${other}`).join(' '))).toBe('SIGNATURE_INVALID')
      }),
    )
  })

  it('rejects a signature header over 4096 characters even with the valid entry', () => {
    fc.assert(
      fc.property(fc.integer({ min: 4097, max: 12_000 }), fc.boolean(), (length, first) => {
        const filler = 'x'.repeat(length - VALID.length - 1)
        const value = first ? `${VALID} ${filler}` : `${filler} ${VALID}`
        expect(value.length).toBe(length)
        expect(signature(value)).toBe('SIGNATURE_INVALID')
      }),
    )
  })

  it('rejects timestamps with more than 16 digits or a leading zero', () => {
    const digits = (min: number, max: number) =>
      fc.string({ unit: fc.constantFrom(...'0123456789'), minLength: min, maxLength: max })
    const tooLong = fc
      .tuple(fc.constantFrom(...'123456789'), digits(16, 30))
      .map(([lead, rest]) => lead + rest)
    const leadingZero = digits(1, 15).map((rest) => `0${rest}`)
    fc.assert(
      fc.property(fc.oneof(tooLong, leadingZero), (timestamp) => {
        expect(verify({ headers: headers({ 'webhook-timestamp': timestamp }) })).toBe(
          'SIGNATURE_INVALID',
        )
      }),
    )
  })

  it('rejects IDs of 256 or more characters or with dots, commas, or whitespace', () => {
    const tooLong = fc.string({
      unit: fc.constantFrom(...ID_CHARS),
      minLength: 256,
      maxLength: 400,
    })
    const forbidden = fc
      .tuple(id, fc.nat(), fc.constantFrom('.', ',', ' ', '\t', '\n', '\r', ' '))
      .map(
        ([value, at, char]) =>
          value.slice(0, at % (value.length + 1)) + char + value.slice(at % (value.length + 1)),
      )
    fc.assert(
      fc.property(fc.oneof(tooLong, forbidden), (value) => {
        expect(verify({ headers: headers({ 'webhook-id': value }) })).toBe('SIGNATURE_INVALID')
      }),
    )
  })

  it('rejects duplicate header names in any casing and array values', () => {
    const name = fc.constantFrom('webhook-id', 'webhook-timestamp', 'webhook-signature')
    const recased = fc
      .tuple(name, fc.array(fc.boolean(), { minLength: 17, maxLength: 17 }))
      .map(([lower, upper]) => ({
        lower,
        cased: [...lower].map((char, n) => (upper[n] ? char.toUpperCase() : char)).join(''),
      }))
      .filter(({ lower, cased }) => lower !== cased)
    fc.assert(
      fc.property(recased, fc.boolean(), ({ lower, cased }, asArray) => {
        const valid = headers() as Record<string, string>
        const duplicated = headers({ [cased]: valid[lower] })
        expect(verify({ headers: duplicated })).toBe('SIGNATURE_INVALID')
        if (asArray) {
          const array = headers({ [lower]: [valid[lower]] })
          expect(verify({ headers: array })).toBe('SIGNATURE_INVALID')
        }
      }),
    )
  })
})

describe('signature timestamp tolerance properties', () => {
  it('accepts exactly when the clock skew in whole seconds is within the tolerance', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 2_000_000, max: MAX_DATE_SECONDS - 2_000_000 }),
        fc.integer({ min: -2_000_000_000, max: 2_000_000_000 }),
        (tolerance, timestamp, skewMs) => {
          const signed = signWebhook({ id: ID, timestamp, body: BODY, secrets: [SECRET] })
          const now = timestamp * 1000 + skewMs
          const expected =
            Math.abs(Math.floor(now / 1000) - timestamp) <= tolerance
              ? 'accepted'
              : 'SIGNATURE_EXPIRED'
          expect(verify({ headers: signed, now: new Date(now), toleranceSeconds: tolerance })).toBe(
            expected,
          )
        },
      ),
    )
  })
})
