import { signWebhook } from './crypto.js'
import { WebhookError } from './errors.js'
import { sendWebhook } from './transport.js'
import { createWorkerStore } from './worker-store.js'
import type { ClaimedDelivery, ResolvedConfig, WorkerResult } from './types.js'

function emptyResult(): WorkerResult {
  return { claimed: 0, succeeded: 0, retried: 0, failed: 0, stale: 0 }
}

function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** Owns neither the caller's database pool nor process signal handlers. Nothing starts until called. */
export function createWorker(config: ResolvedConfig) {
  const store = createWorkerStore(config)
  let ticking = false
  let running = false

  async function deliver(claim: ClaimedDelivery, signal?: AbortSignal) {
    if (signal?.aborted) {
      return store.complete(claim, {
        status: null,
        responseBody: '',
        error: 'Worker stopped; receiver outcome is unknown',
        retryable: true,
        abandoned: true,
      })
    }
    const headers = signWebhook({
      id: claim.eventId,
      timestamp: Math.floor(Date.now() / 1000),
      body: claim.body,
      secrets: claim.secrets,
    })
    const response = await sendWebhook({
      url: claim.url,
      body: claim.body,
      headers,
      timeoutMs: config.timeoutMs,
      maxResponseBytes: config.maxResponseBytes,
      allowLocalhost: config.allowLocalhost,
      ...(signal ? { signal } : {}),
    })
    if (signal?.aborted) {
      return store.complete(claim, {
        ...response,
        error: 'Worker stopped; receiver outcome is unknown',
        retryable: true,
        abandoned: true,
      })
    }
    const retryable =
      response.error !== 'unsafe_url' &&
      response.error !== 'invalid_request' &&
      (response.error !== null ||
        response.status === null ||
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        (response.status >= 500 && response.status < 600))
    return store.complete(claim, {
      ...response,
      retryable,
      error:
        response.error ??
        (response.status !== null && (response.status < 200 || response.status >= 300)
          ? `Receiver returned HTTP ${response.status}`
          : null),
    })
  }

  async function performTick(options: { signal?: AbortSignal } = {}): Promise<WorkerResult> {
    if (ticking)
      throw new WebhookError('INVALID_STATE', 'This worker already has a tick in progress.')
    if (options.signal?.aborted) return emptyResult()
    ticking = true
    try {
      await store.recoverExpired()
      const { claims, errors } = await store.claim(options.signal)
      const result = { ...emptyResult(), claimed: claims.length }
      // Wait for every sibling even if an unexpected internal failure occurs.
      const outcomes = await Promise.allSettled(
        claims.map((claim) => deliver(claim, options.signal)),
      )
      for (const outcome of outcomes) {
        if (outcome.status === 'fulfilled') result[outcome.value]++
        else errors.push(outcome.reason)
      }
      if (errors.length)
        throw new AggregateError(errors, 'Webhook worker could not finish one or more deliveries.')
      return result
    } finally {
      ticking = false
    }
  }

  async function run(options: {
    signal: AbortSignal
    onError?: (error: unknown) => void
    pollIntervalMs?: number
  }): Promise<void> {
    if (running || ticking)
      throw new WebhookError('INVALID_STATE', 'This worker is already running.')
    const pollIntervalMs = options.pollIntervalMs ?? 1000
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 60_000) {
      throw new WebhookError(
        'INVALID_INPUT',
        'The polling interval must be an integer between 10 and 60000 milliseconds.',
      )
    }
    running = true
    try {
      while (!options.signal.aborted) {
        try {
          await performTick({ signal: options.signal })
        } catch (error) {
          if (!options.onError) throw error
          await options.onError(error)
        }
        await waitForPoll(pollIntervalMs, options.signal)
      }
    } finally {
      running = false
    }
  }

  async function tick(options: { signal?: AbortSignal } = {}): Promise<WorkerResult> {
    if (running)
      throw new WebhookError(
        'INVALID_STATE',
        'This worker is running. Stop it before calling tick.',
      )
    return performTick(options)
  }

  return { tick, run, prune: store.prune }
}
