import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { WebhookError } from './errors.js'

const SECRET_PREFIX = 'whsec_'
const ENCRYPTION_CONTEXT = Buffer.from('webhook-secret:v1')

function decodeBase64(value: string): Buffer | null {
  if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null
  }
  const bytes = Buffer.from(value, 'base64')
  return bytes.toString('base64') === value ? bytes : null
}

function signingKey(secret: string): Buffer {
  const key =
    typeof secret === 'string' && secret.startsWith(SECRET_PREFIX)
      ? decodeBase64(secret.slice(SECRET_PREFIX.length))
      : null
  if (!key || key.length < 24 || key.length > 64) {
    throw new WebhookError(
      'INVALID_INPUT',
      'A signing secret must be whsec_ followed by base64 encoding of 24 to 64 bytes.',
    )
  }
  return key
}

/** Create a Standard Webhooks symmetric signing secret. */
export function generateSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString('base64')}`
}

/** Create a key for encrypting endpoint secrets at rest. Keep it outside the database. */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString('base64')
}

export function parseEncryptionKey(value: string | Uint8Array): Uint8Array {
  const bytes =
    typeof value === 'string'
      ? decodeBase64(value)
      : value instanceof Uint8Array
        ? Buffer.from(value)
        : null
  if (!bytes || bytes.length !== 32) {
    throw new WebhookError(
      'INVALID_CONFIG',
      'The encryption key must contain exactly 32 bytes, encoded as base64 or supplied as Uint8Array.',
    )
  }
  return bytes
}

export function encryptSecret(secret: string, key: Uint8Array): string {
  signingKey(secret)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', parseEncryptionKey(key), nonce)
  cipher.setAAD(ENCRYPTION_CONTEXT)
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return [
    'v1',
    nonce.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join('.')
}

export function decryptSecret(ciphertext: string, key: Uint8Array): string {
  const encryptionKey = parseEncryptionKey(key)
  try {
    if (typeof ciphertext !== 'string' || ciphertext.length > 512) throw new Error()
    const [version, nonceText, tagText, encryptedText, extra] = ciphertext.split('.')
    if (version !== 'v1' || !nonceText || !tagText || !encryptedText || extra !== undefined)
      throw new Error()
    const nonce = decodeBase64(nonceText)
    const tag = decodeBase64(tagText)
    const encrypted = decodeBase64(encryptedText)
    if (!nonce || nonce.length !== 12 || !tag || tag.length !== 16 || !encrypted) throw new Error()
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, nonce)
    decipher.setAAD(ENCRYPTION_CONTEXT)
    decipher.setAuthTag(tag)
    const secret = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
    signingKey(secret)
    return secret
  } catch {
    throw new WebhookError(
      'INVALID_CONFIG',
      'The stored signing secret could not be decrypted. Check the encryption key and stored value.',
    )
  }
}

function validId(id: string): boolean {
  return typeof id === 'string' && /^[\x21-\x7e]{1,255}$/.test(id) && !/[.,]/.test(id)
}

function digest(key: Uint8Array, id: string, timestamp: number, body: string | Uint8Array): Buffer {
  return createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest()
}

export function signWebhook(input: {
  id: string
  timestamp: number
  body: string
  secrets: readonly string[]
}): Record<string, string> {
  if (
    !validId(input.id) ||
    !Number.isSafeInteger(input.timestamp) ||
    input.timestamp < 0 ||
    typeof input.body !== 'string'
  ) {
    throw new WebhookError(
      'INVALID_INPUT',
      'Signing requires an ID without dots, commas, or whitespace, an integer Unix timestamp, and the exact body string.',
    )
  }
  if (!Array.isArray(input.secrets) || input.secrets.length < 1 || input.secrets.length > 16) {
    throw new WebhookError('INVALID_INPUT', 'Supply between 1 and 16 signing secrets.')
  }
  return {
    'webhook-id': input.id,
    'webhook-timestamp': String(input.timestamp),
    'webhook-signature': input.secrets
      .map(
        (secret) =>
          `v1,${digest(signingKey(secret), input.id, input.timestamp, input.body).toString('base64')}`,
      )
      .join(' '),
  }
}

function signatureError(): WebhookError {
  return new WebhookError(
    'SIGNATURE_INVALID',
    'Webhook signature headers or signature are invalid.',
  )
}

function readHeaders(headers: Headers | Record<string, string | undefined>): Map<string, string> {
  const result = new Map<string, string>()
  if (!headers || typeof headers !== 'object') throw signatureError()
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers)
  for (const [key, value] of entries) {
    const name = key.toLowerCase()
    if (!['webhook-id', 'webhook-timestamp', 'webhook-signature'].includes(name)) continue
    if (result.has(name) || typeof value !== 'string') throw signatureError()
    result.set(name, value)
  }
  return result
}

/** Verify the exact request body before parsing JSON. The host must deduplicate webhook-id. */
export function verifyWebhook(input: {
  body: string | Uint8Array
  headers: Headers | Record<string, string | undefined>
  secret: string | readonly string[]
  now?: Date
  toleranceSeconds?: number
}): void {
  const tolerance = input.toleranceSeconds ?? 300
  const now = (input.now ?? new Date()).getTime()
  if (!Number.isSafeInteger(tolerance) || tolerance < 0 || !Number.isFinite(now)) {
    throw new WebhookError(
      'INVALID_INPUT',
      'Verification requires a valid date and a nonnegative integer timestamp tolerance.',
    )
  }
  if (typeof input.body !== 'string' && !(input.body instanceof Uint8Array)) {
    throw new WebhookError(
      'INVALID_INPUT',
      'Verify the raw request body as a string or Uint8Array.',
    )
  }
  const secrets = typeof input.secret === 'string' ? [input.secret] : input.secret
  if (!Array.isArray(secrets) || secrets.length < 1 || secrets.length > 16) {
    throw new WebhookError('INVALID_INPUT', 'Supply between 1 and 16 signing secrets.')
  }
  const keys = secrets.map(signingKey)
  const headers = readHeaders(input.headers)
  const id = headers.get('webhook-id')
  const timestampText = headers.get('webhook-timestamp')
  const signatures = headers.get('webhook-signature')
  if (
    !id ||
    !validId(id) ||
    !timestampText ||
    !/^(0|[1-9][0-9]{0,15})$/.test(timestampText) ||
    !signatures ||
    signatures.length > 4096
  ) {
    throw signatureError()
  }
  const timestamp = Number(timestampText)
  if (!Number.isSafeInteger(timestamp)) throw signatureError()
  if (Math.abs(Math.floor(now / 1000) - timestamp) > tolerance) {
    throw new WebhookError(
      'SIGNATURE_EXPIRED',
      'Webhook timestamp is outside the allowed tolerance.',
    )
  }
  const candidates = signatures.split(' ').flatMap((entry) => {
    const [version, value, extra] = entry.split(',')
    if (version !== 'v1' || !value || extra !== undefined) return []
    const bytes = decodeBase64(value)
    return bytes?.length === 32 ? [bytes] : []
  })
  let matched = false
  for (const key of keys) {
    const expected = digest(key, id, timestamp, input.body)
    for (const candidate of candidates) {
      // Compare every candidate so rotation order does not affect verification timing.
      matched = timingSafeEqual(expected, candidate) || matched
    }
  }
  if (!matched) throw signatureError()
}
