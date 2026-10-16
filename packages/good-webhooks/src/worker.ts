import { signWebhook } from './crypto.js'
import { WebhookError } from './errors.js'
import { sendWebhook } from './transport.js'
import { scopeFromKey } from './scope.js'
import {
  createWorkerStore,
  type Completion,
  type CompletionResult,
  type DeliveryOutcome,
} from './worker-store.js'
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

/** Stop claims on caller abort, but give prepared attempts time to finish. */
function shutdown(options: { signal?: AbortSignal; shutdownGraceMs?: number }) {
  const graceMs = options.shutdownGraceMs ?? 30_000
  if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 2_147_483_647) {
    throw new WebhookError(
      'INVALID_INPUT',
      'The shutdown grace period must be an integer between 0 and 2147483647 milliseconds.',
    )
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const abort = () => {
    if (graceMs === 0) controller.abort()
    else timer = setTimeout(() => controller.abort(), graceMs)
  }
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    },
  }
}

/** Owns neither the caller's database pool nor process signal handlers. Nothing starts until called. */
export function createWorker(config: ResolvedConfig) {
  const store = createWorkerStore(config)

  // Publication-only engines may use a narrower source; only a running worker needs pause().
  function requirePause(): void {
    if (config.endpointHealth && typeof config.source.pause !== 'function')
      throw new WebhookError(
        'INVALID_CONFIG',
        'endpointHealth needs an endpoint source with pause(). Set endpointHealth: false to deliver without automatic pauses.',
      )
  }
  let processing = false
  let running = false

  /** Run hooks and automatic pauses after the outcome is committed. Failures join the batch errors. */
  async function after(
    claim: ClaimedDelivery,
    result: CompletionResult,
    outcome: DeliveryOutcome,
    durationMs: number,
    errors: unknown[],
  ): Promise<void> {
    const { hooks, source } = config
    if (!result.attempt || (!hooks.onAttempt && !result.pause)) return
    const scope = scopeFromKey(claim.scopeKey)
    try {
      await hooks.onAttempt?.({
        scope,
        endpointId: claim.endpointId,
        deliveryId: claim.id,
        eventId: claim.eventId,
        eventType: claim.eventType,
        attempt: claim.attemptCount,
        outcome: result.attempt,
        responseStatus: outcome.status,
        error: outcome.error,
        durationMs,
      })
    } catch (error) {
      errors.push(error)
    }
    if (!result.pause) return
    try {
      // requirePause() guarantees pause() whenever endpoint health can produce a pause.
      const paused = await source.pause!(scope, claim.endpointId, {
        reason: result.pause,
        ...(claim.revision === null ? {} : { revision: claim.revision }),
      })
      if (paused)
        await hooks.onEndpointPaused?.({
          scope,
          endpointId: claim.endpointId,
          reason: result.pause,
        })
    } catch (error) {
      errors.push(error)
    }
  }

  /** Send one attempt and classify its response. Never throws for receiver failures. */
  async function attempt(claim: ClaimedDelivery, signal?: AbortSignal): Promise<DeliveryOutcome> {
    const stopped = {
      error: 'Worker stopped; receiver outcome is unknown',
      retryable: true,
      abandoned: true,
    }
    if (signal?.aborted) return { status: null, responseBody: '', ...stopped }
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
    const { status, responseBody } = response
    if (signal?.aborted) return { status, responseBody, ...stopped }
    const retryable =
      response.error !== 'unsafe_url' &&
      response.error !== 'invalid_request' &&
      (response.error !== null ||
        status === null ||
        status === 408 ||
        status === 425 ||
        status === 429 ||
        (status >= 500 && status < 600))
    return {
      status,
      responseBody,
      retryable,
      retryAfterMs:
        config.respectRetryAfter && (status === 429 || status === 503)
          ? (response.retryAfterMs ?? null)
          : null,
      error:
        response.error ??
        (status !== null && (status < 200 || status >= 300)
          ? `Receiver returned HTTP ${status}`
          : null),
    }
  }

  async function deliver(
    claim: ClaimedDelivery,
    errors: unknown[],
    signal?: AbortSignal,
  ): Promise<Completion> {
    const started = performance.now()
    const outcome = await attempt(claim, signal)
    const result = await store.complete(claim, outcome)
    await after(claim, result, outcome, Math.round(performance.now() - started), errors)
    return result.completion
  }

  async function performBatch(
    stopSignal: AbortSignal | undefined,
    sendSignal: AbortSignal,
  ): Promise<WorkerResult> {
    if (processing)
      throw new WebhookError('INVALID_STATE', 'This worker already has a batch in progress.')
    if (stopSignal?.aborted) return emptyResult()
    processing = true
    try {
      await store.recoverExpired()
      const { claims, errors } = await store.claim(stopSignal)
      const result = { ...emptyResult(), claimed: claims.length }
      // Wait for every sibling even if an unexpected internal failure occurs.
      const outcomes = await Promise.allSettled(
        claims.map((claim) => deliver(claim, errors, sendSignal)),
      )
      for (const outcome of outcomes) {
        if (outcome.status === 'fulfilled') result[outcome.value]++
        else errors.push(outcome.reason)
      }
      if (errors.length)
        throw new AggregateError(errors, 'Webhook worker could not finish one or more deliveries.')
      return result
    } finally {
      processing = false
    }
  }

  async function run(options: {
    signal: AbortSignal
    onError?: (error: unknown) => void
    pollIntervalMs?: number
    shutdownGraceMs?: number
  }): Promise<void> {
    if (running || processing)
      throw new WebhookError('INVALID_STATE', 'This worker is already running.')
    requirePause()
    const pollIntervalMs = options.pollIntervalMs ?? 1000
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 60_000) {
      throw new WebhookError(
        'INVALID_INPUT',
        'The polling interval must be an integer between 10 and 60000 milliseconds.',
      )
    }
    const lifecycle = shutdown(options)
    running = true
    try {
      while (!options.signal.aborted) {
        try {
          const result = await performBatch(options.signal, lifecycle.signal)
          if (result.succeeded + result.retried + result.failed > 0) continue
        } catch (error) {
          if (!options.onError) throw error
          await options.onError(error)
        }
        await waitForPoll(pollIntervalMs, options.signal)
      }
    } finally {
      lifecycle.dispose()
      running = false
    }
  }

  async function runOnce(
    options: { signal?: AbortSignal; shutdownGraceMs?: number } = {},
  ): Promise<WorkerResult> {
    if (running)
      throw new WebhookError(
        'INVALID_STATE',
        'This worker is running. Stop it before calling runOnce.',
      )
    requirePause()
    const lifecycle = shutdown(options)
    try {
      return await performBatch(options.signal, lifecycle.signal)
    } finally {
      lifecycle.dispose()
    }
  }

  return { runOnce, run, prune: store.prune }
}
