import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { WebhookError } from '../errors.js'
import { isLoopback, isPublicAddress, parseEndpointUrl, unsafeUrl } from './url.js'

export type ResolvedTarget = {
  url: URL
  hostname: string
  address: { address: string; family: number }
}

/** Distinguishes retryable DNS failures from destinations rejected by the URL policy. */
export class DnsResolutionError extends Error {
  constructor() {
    super('The webhook host could not be resolved.')
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** Validate every DNS answer and return one vetted address for a pinned connection. */
export async function resolveTarget(
  input: string,
  allowLocalhost: boolean,
  signal: AbortSignal,
  maxLength = 2048,
): Promise<ResolvedTarget> {
  const { url, hostname, local } = parseEndpointUrl(input, allowLocalhost, maxLength)
  if (signal.aborted) throw signal.reason
  let addresses: ResolvedTarget['address'][]
  if (isIP(hostname)) {
    addresses = [{ address: hostname, family: isIP(hostname) }]
  } else {
    try {
      addresses = await raceAbort(lookup(hostname, { all: true, verbatim: true }), signal)
    } catch {
      if (signal.aborted) throw signal.reason
      throw new DnsResolutionError()
    }
  }
  if (
    addresses.length === 0 ||
    addresses.some(
      ({ address, family }) =>
        isIP(address) !== family ||
        (local && allowLocalhost ? !isLoopback(address) : !isPublicAddress(address)),
    )
  )
    throw unsafeUrl()
  // Prefer IPv4 for workers without an IPv6 route. Every answer must still be safe.
  const address = addresses.find((entry) => entry.family === 4) ?? addresses[0]
  if (!address) throw unsafeUrl()
  return { url, hostname, address }
}

/** Optional Node registration check. Delivery must resolve and validate again before sending. */
export async function validateResolvedUrl(input: string, allowLocalhost: boolean): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(unsafeUrl()), 10_000)
  try {
    await resolveTarget(input, allowLocalhost, controller.signal)
  } catch (error) {
    if (error instanceof WebhookError) throw error
    throw new WebhookError('UNSAFE_URL', 'The webhook host could not be resolved and validated.')
  } finally {
    clearTimeout(timer)
  }
}
