import { WebhookError } from './errors.js'
import type { Scope } from './types.js'

// Tagged tuples keep the application scope distinct from every named scope.
export const APPLICATION_SCOPE = JSON.stringify(['application'])

/** Validate and snapshot before any asynchronous work. Keys never enter the public API. */
export function scopeKey(scope: Scope): string {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new WebhookError('INVALID_INPUT', 'A scope with type and id is required.')
  }
  const { type, id } = scope
  for (const [name, value, limit] of [
    ['type', type, 64],
    ['id', id, 200],
  ] as const) {
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > limit ||
      value.includes('\0')
    ) {
      throw new WebhookError(
        'INVALID_INPUT',
        `Scope ${name} must contain 1–${limit} characters and no null bytes.`,
      )
    }
  }
  return JSON.stringify(['named', type, id])
}
