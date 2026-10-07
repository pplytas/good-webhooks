import ipaddr from 'ipaddr.js'
import { WebhookError } from '../errors.js'

export function unsafeUrl(): WebhookError {
  return new WebhookError(
    'UNSAFE_URL',
    'Webhook URLs must use HTTPS and public IP addresses. Localhost requires explicit development configuration.',
  )
}

export function isLoopback(address: string): boolean {
  return ipaddr.isValid(address) && ipaddr.parse(address).range() === 'loopback'
}

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address) || address.includes('%')) return false
  const parsed = ipaddr.parse(address)
  if (parsed.range() !== 'unicast') return false
  if (parsed.kind() === 'ipv6') {
    return (parsed as ipaddr.IPv6).match(ipaddr.IPv6.parse('2000::'), 3)
  }
  return address !== '168.63.129.16'
}

/** Portable URL checks. Registration defaults to 2048 characters; senders can set their own limit. */
export function parseEndpointUrl(
  input: string,
  allowLocalhost: boolean,
  maxLength = 2048,
): { url: URL; hostname: string; local: boolean } {
  if (
    typeof input !== 'string' ||
    input.length < 1 ||
    input.length > maxLength ||
    /[\s\\\x00-\x1f\x7f#]/.test(input)
  )
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
  if (ipaddr.isValid(hostname) && !(local && allowLocalhost) && !isPublicAddress(hostname))
    throw unsafeUrl()
  return { url, hostname, local }
}
