import { lookup } from 'node:dns/promises'
import http, { type ClientRequest, type IncomingMessage } from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { checkServerIdentity } from 'node:tls'
import ipaddr from 'ipaddr.js'
import { WebhookError } from './errors.js'

type Address = { address: string; family: number }
type Target = { url: URL; hostname: string; address: Address }
type SendResult = { status: number | null; responseBody: string; error: string | null }

class TransportFailure extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

function unsafeUrl(): WebhookError {
  return new WebhookError(
    'UNSAFE_URL',
    'Webhook URLs must use HTTPS and resolve only to public IP addresses. Localhost requires explicit development configuration.',
  )
}

function isLoopback(address: string): boolean {
  return ipaddr.isValid(address) && ipaddr.parse(address).range() === 'loopback'
}

function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address) || address.includes('%')) return false
  const parsed = ipaddr.parse(address)
  if (parsed.range() !== 'unicast') return false
  if (parsed.kind() === 'ipv6') {
    // Special ranges are excluded above. Limit the rest to global unicast.
    const ipv6 = parsed as ipaddr.IPv6
    return ipv6.match(ipaddr.IPv6.parse('2000::'), 3)
  }
  // This otherwise public address exposes Azure's internal platform services.
  return address !== '168.63.129.16'
}

function parseUrl(
  input: string,
  allowLocalhost: boolean,
): { url: URL; hostname: string; local: boolean } {
  if (typeof input !== 'string' || input.length > 8192 || /[\s\\\x00-\x1f\x7f#]/.test(input))
    throw unsafeUrl()
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw unsafeUrl()
  }
  const authority = input.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/)?.[1]
  if (!authority || authority.includes('@') || url.username || url.password || url.hash)
    throw unsafeUrl()
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const local = hostname === 'localhost' || isLoopback(hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowLocalhost && local))
    throw unsafeUrl()
  if (local && !allowLocalhost) throw unsafeUrl()
  if (hostname.endsWith('.') || hostname.includes('%')) throw unsafeUrl()
  return { url, hostname, local }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

async function resolveTarget(
  input: string,
  allowLocalhost: boolean,
  signal: AbortSignal,
): Promise<Target> {
  const { url, hostname, local } = parseUrl(input, allowLocalhost)
  if (signal.aborted) throw signal.reason
  let addresses: Address[]
  if (isIP(hostname)) {
    addresses = [{ address: hostname, family: isIP(hostname) }]
  } else {
    try {
      addresses = await raceAbort(lookup(hostname, { all: true, verbatim: true }), signal)
    } catch (error) {
      if (signal.aborted) throw signal.reason
      throw new TransportFailure('dns_error')
    }
  }
  if (
    addresses.length === 0 ||
    addresses.some(
      ({ address, family }) =>
        isIP(address) !== family ||
        (local && allowLocalhost ? !isLoopback(address) : !isPublicAddress(address)),
    )
  ) {
    throw unsafeUrl()
  }
  // Prefer IPv4 for workers without an IPv6 route. All answers must still pass validation.
  const address = addresses.find((entry) => entry.family === 4) ?? addresses[0]
  if (!address) throw unsafeUrl()
  return { url, hostname, address }
}

/** Validate registration input. Delivery resolves and validates again on every attempt. */
export async function assertSafeUrl(url: string, allowLocalhost: boolean): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new TransportFailure('timeout')), 10_000)
  try {
    await resolveTarget(url, allowLocalhost, controller.signal)
  } catch (error) {
    if (error instanceof WebhookError) throw error
    throw new WebhookError('UNSAFE_URL', 'The webhook host could not be resolved and validated.')
  } finally {
    clearTimeout(timer)
  }
}

function requestHeaders(
  headers: Record<string, string>,
  target: Target,
  body: string,
): Record<string, string> {
  const result: Record<string, string> = {}
  const reserved = new Set([
    'host',
    'content-length',
    'transfer-encoding',
    'connection',
    'upgrade',
    'expect',
    'proxy-authorization',
    'proxy-connection',
    'trailer',
    'te',
  ])
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase()
    if (
      reserved.has(normalized) ||
      Object.hasOwn(result, normalized) ||
      typeof value !== 'string'
    ) {
      throw new TransportFailure('invalid_request')
    }
    try {
      http.validateHeaderName(name)
      http.validateHeaderValue(name, value)
    } catch {
      throw new TransportFailure('invalid_request')
    }
    result[normalized] = value
  }
  return {
    'content-type': 'application/json',
    ...result,
    host: target.url.host,
    'content-length': String(Buffer.byteLength(body)),
    connection: 'close',
  }
}

function responsePreview(chunks: Buffer[], size: number, maxBytes: number): string {
  // PostgreSQL text cannot store NUL, and invalid UTF-8 expands during decoding.
  // Bound the stored UTF-8 text too, without leaving an incomplete character.
  const text = Buffer.concat(chunks, size).toString('utf8').replaceAll('\0', '\uFFFD')
  const bytes = Buffer.from(text)
  return new StringDecoder('utf8').write(bytes.subarray(0, maxBytes))
}

function performRequest(
  target: Target,
  input: {
    body: string
    headers: Record<string, string>
    maxResponseBytes: number
  },
  signal: AbortSignal,
): Promise<SendResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    let request: ClientRequest | undefined
    let response: IncomingMessage | undefined
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (error: string | null = null) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      resolve({
        status: response?.statusCode ?? null,
        responseBody: responsePreview(chunks, size, input.maxResponseBytes),
        error,
      })
      response?.destroy()
      request?.destroy()
    }
    const abort = () =>
      finish(signal.reason instanceof TransportFailure ? signal.reason.reason : 'aborted')
    signal.addEventListener('abort', abort, { once: true })
    try {
      const options: https.RequestOptions = {
        protocol: target.url.protocol,
        // The connection uses the vetted IP directly, so no second DNS lookup can rebind it.
        hostname: target.address.address,
        family: target.address.family,
        port: target.url.port || undefined,
        path: `${target.url.pathname}${target.url.search}`,
        method: 'POST',
        headers: requestHeaders(input.headers, target, input.body),
        agent: false,
        maxHeaderSize: 16_384,
        rejectUnauthorized: true,
        servername: isIP(target.hostname) ? '' : target.hostname,
        checkServerIdentity: (_hostname, certificate) =>
          checkServerIdentity(target.hostname, certificate),
      }
      const makeRequest = target.url.protocol === 'https:' ? https.request : http.request
      request = makeRequest(options, (incoming) => {
        response = incoming
        incoming.on('error', () => finish('network_error'))
        incoming.on('aborted', () => finish('network_error'))
        incoming.on('data', (chunk: Buffer) => {
          const remaining = input.maxResponseBytes - size
          if (remaining > 0) {
            const retained = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
            chunks.push(retained)
            size += retained.length
          }
          // Release the connection as soon as the diagnostic limit is reached.
          if (size >= input.maxResponseBytes) finish()
        })
        incoming.on('end', () => finish())
        if (input.maxResponseBytes === 0) finish()
      })
      request.on('error', () =>
        finish(signal.aborted ? (signal.reason as TransportFailure).reason : 'network_error'),
      )
      request.end(input.body)
    } catch (error) {
      finish(error instanceof TransportFailure ? error.reason : 'invalid_request')
    }
  })
}

/** Send one attempt. Redirects are returned as responses and are never followed. */
export async function sendWebhook(input: {
  url: string
  body: string
  headers: Record<string, string>
  timeoutMs: number
  maxResponseBytes: number
  allowLocalhost: boolean
  signal?: AbortSignal
}): Promise<SendResult> {
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 2_147_483_647 ||
    !Number.isSafeInteger(input.maxResponseBytes) ||
    input.maxResponseBytes < 0 ||
    input.maxResponseBytes > 1_048_576 ||
    typeof input.body !== 'string' ||
    !input.headers ||
    typeof input.headers !== 'object'
  ) {
    return { status: null, responseBody: '', error: 'invalid_request' }
  }
  const controller = new AbortController()
  const abort = () => controller.abort(new TransportFailure('aborted'))
  if (input.signal?.aborted) abort()
  else input.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new TransportFailure('timeout')), input.timeoutMs)
  try {
    const target = await resolveTarget(input.url, input.allowLocalhost, controller.signal)
    return await performRequest(target, input, controller.signal)
  } catch (error) {
    return {
      status: null,
      responseBody: '',
      error:
        error instanceof WebhookError
          ? 'unsafe_url'
          : error instanceof TransportFailure
            ? error.reason
            : 'network_error',
    }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', abort)
  }
}
