import { WebhookError } from './errors.js'
import type { JsonValue } from './types.js'

/** Canonical JSON rejects lossy coercions, cycles, and values that cannot travel over the wire. */
export function toJson(value: unknown): JsonValue {
  const ancestors = new Set<object>()
  function visit(input: unknown, depth: number): JsonValue {
    if (depth > 64)
      throw new WebhookError('INVALID_INPUT', 'Event payload exceeds the maximum depth of 64.')
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
    if (typeof input === 'number' && Number.isFinite(input)) return input
    if (typeof input !== 'object' || input === null || ancestors.has(input)) {
      throw new WebhookError(
        'INVALID_INPUT',
        'Event payload must contain finite, non-circular JSON values.',
      )
    }
    ancestors.add(input)
    try {
      if (Array.isArray(input)) return Array.from(input, (item) => visit(item, depth + 1))
      if (
        Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null
      ) {
        throw new WebhookError('INVALID_INPUT', 'Event payload must contain plain JSON objects.')
      }
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, visit((input as Record<string, unknown>)[key], depth + 1)]),
      )
    } finally {
      ancestors.delete(input)
    }
  }
  const result = visit(value, 0)
  if (Buffer.byteLength(JSON.stringify(result)) > 262144)
    throw new WebhookError('INVALID_INPUT', 'Event payload exceeds 256 KiB.')
  return result
}
