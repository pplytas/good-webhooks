import { WebhookError } from '../errors.js'

/** Hop-by-hop and framing headers the transport sets itself or refuses from any caller. */
export const TRANSPORT_HEADER_NAMES: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'expect',
  'proxy-authorization',
  'proxy-connection',
  'trailer',
  'te',
])

/** Lowercase names an endpoint may not set. Names starting with `webhook-` are reserved as well. */
export const RESERVED_HEADER_NAMES: ReadonlySet<string> = new Set([
  'content-type',
  'user-agent',
  ...TRANSPORT_HEADER_NAMES,
])

export const MAX_ENDPOINT_HEADERS = 20
const MAX_NAME_LENGTH = 100
/**
 * UTF-8 bytes of the headers as JSON, the exact plaintext management encrypts. Keeps the encrypted
 * blob inside narrow Better Auth columns such as SQL Server's varchar(8000), which stores it as hex.
 */
export const MAX_ENDPOINT_HEADER_BYTES = 2048
/** RFC 9110 token. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
/**
 * Visible ASCII, space, and tab. The transport sends a string body, so Node encodes the header
 * block as UTF-8 and would turn Latin-1 text into different bytes on the wire.
 */
const FIELD_VALUE = /^[\t\x20-\x7E]+$/

/** True for signing headers (`webhook-*`), the content headers the library sets, and hop-by-hop names. */
export function isReservedHeaderName(name: string): boolean {
  const normalized = name.toLowerCase()
  return normalized.startsWith('webhook-') || RESERVED_HEADER_NAMES.has(normalized)
}

function invalid(message: string): never {
  throw new WebhookError('INVALID_INPUT', message)
}

/**
 * Validate and copy endpoint headers. Synchronous and portable, so callers can run it before
 * their first await. Rejects with INVALID_INPUT.
 */
export function validateEndpointHeaders(value: unknown): Record<string, string> {
  const prototype = value && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined
  if (prototype !== Object.prototype && prototype !== null)
    invalid('Endpoint headers must be an object of header names and string values.')
  const entries = Object.entries(value as object)
  if (entries.length > MAX_ENDPOINT_HEADERS)
    invalid(`An endpoint may have at most ${MAX_ENDPOINT_HEADERS} headers.`)
  const seen = new Set<string>()
  for (const [name, header] of entries) {
    if (name.length > MAX_NAME_LENGTH || !TOKEN.test(name))
      invalid(`Header names must be HTTP tokens of 1–${MAX_NAME_LENGTH} characters.`)
    const normalized = name.toLowerCase()
    if (seen.has(normalized)) invalid(`Header ${name} appears more than once.`)
    seen.add(normalized)
    if (isReservedHeaderName(name)) invalid(`Header ${name} is reserved.`)
    if (typeof header !== 'string' || !FIELD_VALUE.test(header))
      invalid(`Header ${name} must have a nonempty value of visible ASCII, spaces, and tabs.`)
  }
  // fromEntries defines own properties, even for a name such as __proto__.
  const headers = Object.fromEntries(entries) as Record<string, string>
  if (new TextEncoder().encode(JSON.stringify(headers)).length > MAX_ENDPOINT_HEADER_BYTES)
    invalid(`Endpoint headers may hold at most ${MAX_ENDPOINT_HEADER_BYTES} bytes as JSON.`)
  return headers
}
