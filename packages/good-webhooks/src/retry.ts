import { randomInt } from 'node:crypto'

/**
 * The retry-schedule decision, extracted from the worker store so it can be
 * exercised database-free. `computeRetryAt` returns the next attempt time, or
 * null when the schedule is exhausted or the retry window would be exceeded.
 * A null window start means the delivery is paused: the window begins now.
 */
export function computeRetryAt(input: {
  attemptCount: number
  windowStartedAt: Date | null
  now: Date
  delaysMs: readonly number[]
  maxAgeMs: number
  /** A longer receiver-provided Retry-After wins over the scheduled delay. */
  minimumDelayMs?: number | null
  /** Injectable jitter source; defaults to a cryptographically random integer. */
  randomInt?: (exclusiveMax: number) => number
}): Date | null {
  const start = input.windowStartedAt ?? input.now
  const scheduled = input.delaysMs[input.attemptCount - 1]
  if (
    scheduled === undefined ||
    (input.windowStartedAt !== null &&
      input.now.getTime() - input.windowStartedAt.getTime() >= input.maxAgeMs)
  )
    return null
  // A longer Retry-After wins, but never extends the retry window.
  const delay = Math.max(scheduled, input.minimumDelayMs ?? 0)
  // A bounded 0-20% delay avoids synchronized retries without retrying early.
  const jitter =
    delay > 0 ? (input.randomInt ?? randomInt)(Math.min(Math.floor(delay / 5), 2 ** 48 - 2) + 1) : 0
  const next = new Date(input.now.getTime() + delay + jitter)
  return next.getTime() <= start.getTime() + input.maxAgeMs ? next : null
}

/** True when no further attempts may be scheduled for the delivery. */
export function isRetryExhausted(input: {
  attemptCount: number
  windowStartedAt: Date | null
  now: Date
  delaysMs: readonly number[]
  maxAgeMs: number
}): boolean {
  return (
    input.attemptCount >= input.delaysMs.length + 1 ||
    (input.windowStartedAt !== null &&
      input.now.getTime() - input.windowStartedAt.getTime() >= input.maxAgeMs)
  )
}
