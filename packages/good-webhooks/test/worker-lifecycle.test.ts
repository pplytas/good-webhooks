import { getEventListeners } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecret } from '../src/crypto.js'
import { scopeKey } from '../src/scope.js'
import { sendWebhook } from '../src/transport.js'
import { createWorkerStore, type Completion, type CompletionResult } from '../src/worker-store.js'
import { createWorker } from '../src/worker.js'
import type { ClaimedDelivery, ResolvedConfig } from '../src/types.js'

vi.mock('../src/worker-store.js')
vi.mock('../src/transport.js')

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const claim: ClaimedDelivery = {
  id: '1',
  scopeKey: 'scope',
  endpointId: 'endpoint',
  eventId: 'event',
  eventType: 'order.created',
  token: 'token',
  body: '{}',
  url: 'https://example.com/hook',
  secrets: [generateSecret()],
  attemptCount: 1,
  createdAt: new Date(),
  eventCreatedAt: new Date(),
}
const config: ResolvedConfig = {
  database: { query: vi.fn(), connect: vi.fn() },
  schema: 'public',
  source: { matchRecipients: vi.fn(), resolveEndpoint: vi.fn() },
  retryDelaysMs: [1000],
  maxAgeMs: 60_000,
  timeoutMs: 10_000,
  concurrency: 1,
  leaseMs: 60_000,
  maxResponseBytes: 1024,
  retentionMs: 86_400_000,
  allowLocalhost: false,
  respectRetryAfter: true,
  endpointHealth: null,
  hooks: {},
}
const store = {
  recoverExpired: vi.fn(async () => {}),
  claim: vi.fn<ReturnType<typeof createWorkerStore>['claim']>(),
  complete: vi.fn<ReturnType<typeof createWorkerStore>['complete']>(),
  prune: vi.fn(async () => 0),
}
const success = { status: 200, responseBody: 'ok', error: null }
const completed = (completion: Completion): CompletionResult => ({
  completion,
  outcome: completion === 'stale' ? null : completion === 'retried' ? 'retry' : completion,
  pause: null,
})

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.mocked(createWorkerStore).mockReturnValue(store)
  store.claim.mockResolvedValue({ claims: [], errors: [] })
  store.complete.mockResolvedValue(completed('succeeded'))
  vi.mocked(sendWebhook).mockResolvedValue(success)
})
afterEach(() => vi.useRealTimers())

function start(method: 'run' | 'runOnce', controller: AbortController, shutdownGraceMs?: number) {
  store.claim.mockResolvedValueOnce({ claims: [claim], errors: [] })
  const worker = createWorker(config)
  const options = {
    signal: controller.signal,
    ...(shutdownGraceMs === undefined ? {} : { shutdownGraceMs }),
  }
  return { worker, pending: worker[method](options) }
}

describe('worker shutdown deadlines', () => {
  it.each(['run', 'runOnce'] as const)(
    '%s finishes an active attempt and cancels its shutdown timer',
    async (method) => {
      const response = deferred<Awaited<ReturnType<typeof sendWebhook>>>()
      vi.mocked(sendWebhook).mockReturnValue(response.promise)
      const controller = new AbortController()
      const { worker, pending } = start(method, controller)
      await vi.advanceTimersByTimeAsync(0)
      controller.abort()
      await expect(worker.runOnce()).rejects.toMatchObject({ code: 'INVALID_STATE' })
      await expect(worker.run({ signal: controller.signal })).rejects.toMatchObject({
        code: 'INVALID_STATE',
      })
      response.resolve(success)
      await pending
      expect(store.complete).toHaveBeenCalledWith(
        claim,
        expect.objectContaining({ status: 200, retryable: false }),
      )
      expect(store.complete.mock.calls[0]![1].abandoned).toBeUndefined()
      expect(store.claim).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      await worker.runOnce()
    },
  )

  it.each([
    ['run', undefined],
    ['runOnce', undefined],
    ['run', 50],
    ['runOnce', 50],
    ['run', 0],
    ['runOnce', 0],
  ] as const)(
    '%s requests cancellation after grace %s starts at abort',
    async (method, shutdownGraceMs) => {
      const response = deferred<Awaited<ReturnType<typeof sendWebhook>>>()
      vi.mocked(sendWebhook).mockReturnValue(response.promise)
      const controller = new AbortController()
      const { pending } = start(method, controller, shutdownGraceMs)
      await vi.advanceTimersByTimeAsync(100_000)
      const sendSignal = vi.mocked(sendWebhook).mock.calls[0]![0].signal!
      expect(sendSignal.aborted).toBe(false)
      controller.abort()
      expect(store.claim.mock.calls[0]![0]?.aborted).toBe(true)
      const grace = shutdownGraceMs ?? 30_000
      if (grace > 0) {
        await vi.advanceTimersByTimeAsync(grace - 1)
        expect(sendSignal.aborted).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
      }
      expect(sendSignal.aborted).toBe(true)
      response.resolve({ status: null, responseBody: '', error: 'aborted' })
      await pending
      expect(store.complete).toHaveBeenCalledWith(
        claim,
        expect.objectContaining({ abandoned: true, retryable: true }),
      )
      expect(vi.getTimerCount()).toBe(0)
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    },
  )

  it('awaits completion writes beyond the grace period and preserves a known response', async () => {
    const completion = deferred<CompletionResult>()
    store.complete.mockReturnValue(completion.promise)
    const controller = new AbortController()
    const { worker, pending } = start('runOnce', controller, 10)
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.complete).toHaveBeenCalledTimes(1)
    controller.abort()
    await vi.advanceTimersByTimeAsync(100)
    expect(settled).toBe(false)
    await expect(worker.runOnce()).rejects.toMatchObject({ code: 'INVALID_STATE' })
    expect(store.complete.mock.calls[0]![1].abandoned).toBeUndefined()
    completion.resolve(completed('succeeded'))
    await expect(pending).resolves.toMatchObject({ succeeded: 1 })
  })

  it.each(['run', 'runOnce'] as const)(
    '%s cleans up its abort listener on infrastructure failure',
    async (method) => {
      store.recoverExpired.mockRejectedValueOnce(new Error('database unavailable'))
      const controller = new AbortController()
      const { pending } = start(method, controller)
      await expect(pending).rejects.toThrow('database unavailable')
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      controller.abort()
      expect(vi.getTimerCount()).toBe(0)
    },
  )
})

describe('continuous worker cadence', () => {
  it.each(['succeeded', 'retried', 'failed'] as const)(
    'immediately checks for more work after %s, then waits when idle',
    async (outcome) => {
      store.complete.mockResolvedValue(completed(outcome))
      const controller = new AbortController()
      const { pending } = start('run', controller)
      await vi.advanceTimersByTimeAsync(0)
      expect(store.claim).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(999)
      expect(store.claim).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(store.claim).toHaveBeenCalledTimes(3)
      controller.abort()
      await pending
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('waits after a batch where all claims became stale', async () => {
    store.complete.mockResolvedValue(completed('stale'))
    const controller = new AbortController()
    const { pending } = start('run', controller)
    await vi.advanceTimersByTimeAsync(999)
    expect(store.claim).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(store.claim).toHaveBeenCalledTimes(2)
    controller.abort()
    await pending
  })

  it('awaits the error callback and delays even after healthy siblings made progress', async () => {
    const error = new Error('provider unavailable')
    store.claim.mockResolvedValueOnce({ claims: [claim], errors: [error] })
    const callback = deferred<void>()
    const onError = vi.fn(() => callback.promise)
    const controller = new AbortController()
    const pending = createWorker(config).run({
      signal: controller.signal,
      pollIntervalMs: 50,
      onError,
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ errors: [error] }))
    expect(store.claim).toHaveBeenCalledTimes(1)
    callback.resolve()
    await vi.advanceTimersByTimeAsync(49)
    expect(store.claim).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(store.claim).toHaveBeenCalledTimes(2)
    controller.abort()
    await pending
  })

  it('runOnce processes only one batch even when more work is available', async () => {
    store.claim.mockResolvedValue({ claims: [claim], errors: [] })
    expect(await createWorker(config).runOnce()).toMatchObject({ claimed: 1, succeeded: 1 })
    expect(store.claim).toHaveBeenCalledTimes(1)
    expect(store.prune).not.toHaveBeenCalled()
  })
})

describe('hooks and automatic pauses', () => {
  const scopedClaim = { ...claim, scopeKey: scopeKey({ type: 'user', id: 'u1' }), revision: '3' }

  it('reports hook errors through the batch without losing recorded outcomes', async () => {
    const hookError = new Error('metrics backend down')
    const pause = vi.fn(async () => true)
    const onEndpointPaused = vi.fn()
    store.claim.mockResolvedValueOnce({ claims: [scopedClaim], errors: [] })
    store.complete.mockResolvedValueOnce({
      completion: 'retried',
      outcome: 'retry',
      pause: 'failing',
    })
    const worker = createWorker({
      ...config,
      source: { ...config.source, pause },
      endpointHealth: { pauseAfterMs: 432_000_000, pauseOnGone: true },
      hooks: {
        onAttempt: () => {
          throw hookError
        },
        onEndpointPaused,
      },
    })
    await expect(worker.runOnce()).rejects.toMatchObject({ errors: [hookError] })
    expect(store.complete).toHaveBeenCalledTimes(1)
    expect(pause).toHaveBeenCalledWith({ type: 'user', id: 'u1' }, 'endpoint', {
      reason: 'failing',
      revision: '3',
    })
    expect(onEndpointPaused).toHaveBeenCalledWith({
      scope: { type: 'user', id: 'u1' },
      endpointId: 'endpoint',
      reason: 'failing',
    })
  })

  it('reports a pause only when the source applied it', async () => {
    const onEndpointPaused = vi.fn()
    store.claim.mockResolvedValueOnce({ claims: [scopedClaim], errors: [] })
    store.complete.mockResolvedValueOnce({ completion: 'failed', outcome: 'failed', pause: 'gone' })
    const worker = createWorker({
      ...config,
      source: { ...config.source, pause: async () => false },
      endpointHealth: { pauseAfterMs: 432_000_000, pauseOnGone: true },
      hooks: { onEndpointPaused },
    })
    expect(await worker.runOnce()).toMatchObject({ failed: 1 })
    expect(onEndpointPaused).not.toHaveBeenCalled()
  })

  it.each(['run', 'runOnce'] as const)(
    '%s refuses to start without pause() while automatic pauses are on',
    async (method) => {
      const worker = createWorker({
        ...config,
        endpointHealth: { pauseAfterMs: 432_000_000, pauseOnGone: true },
      })
      await expect(worker[method]({ signal: new AbortController().signal })).rejects.toMatchObject({
        code: 'INVALID_CONFIG',
      })
      expect(store.claim).not.toHaveBeenCalled()
    },
  )
})
