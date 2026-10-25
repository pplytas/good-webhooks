import type { Attributes, Meter } from '@opentelemetry/api'
import { describe, expect, it } from 'vitest'
import type { AttemptEvent } from '../src/types.js'
import { createOtelHooks } from '../examples/operations/otel.ts'

const attempt: AttemptEvent = {
  scope: { type: 'organization', id: 'org_1' },
  endpointId: 'endpoint_1',
  deliveryId: 'delivery_1',
  eventId: 'event_1',
  eventType: 'invoice.paid',
  attempt: 1,
  outcome: 'succeeded',
  responseStatus: 204,
  error: null,
  durationMs: 42,
}

function fakeMeter() {
  const recorded: { name: string; value: number; attributes: Attributes | undefined }[] = []
  const instrument = (name: string) => {
    const record = (value: number, attributes?: Attributes) =>
      void recorded.push({ name, value, attributes })
    return { record, add: record }
  }
  const meter = { createHistogram: instrument, createCounter: instrument } as unknown as Meter
  return { meter, recorded }
}

describe('OpenTelemetry recipe', () => {
  it('records nothing and does not throw without a registered provider', async () => {
    const hooks = createOtelHooks()
    await hooks.onAttempt?.(attempt)
    await hooks.onEndpointPaused?.({ scope: null, endpointId: 'endpoint_1', reason: 'gone' })
  })

  it('records a succeeded 2xx attempt', async () => {
    const { meter, recorded } = fakeMeter()
    await createOtelHooks({ meter }).onAttempt?.(attempt)
    expect(recorded).toEqual([
      {
        name: 'good_webhooks.attempt.duration',
        value: 0.042,
        attributes: { outcome: 'succeeded', event_type: 'invoice.paid' },
      },
      {
        name: 'good_webhooks.attempts',
        value: 1,
        attributes: { outcome: 'succeeded', event_type: 'invoice.paid' },
      },
      {
        name: 'good_webhooks.attempt.responses',
        value: 1,
        attributes: { status_class: '2xx', event_type: 'invoice.paid' },
      },
    ])
  })

  it('records a failed attempt without a response under a custom prefix', async () => {
    const { meter, recorded } = fakeMeter()
    await createOtelHooks({ meter, prefix: 'billing.webhooks' }).onAttempt?.({
      ...attempt,
      outcome: 'failed',
      responseStatus: null,
      error: 'network_error',
      durationMs: 1500,
    })
    expect(recorded).toEqual([
      {
        name: 'billing.webhooks.attempt.duration',
        value: 1.5,
        attributes: { outcome: 'failed', event_type: 'invoice.paid' },
      },
      {
        name: 'billing.webhooks.attempts',
        value: 1,
        attributes: { outcome: 'failed', event_type: 'invoice.paid' },
      },
      {
        name: 'billing.webhooks.attempt.responses',
        value: 1,
        attributes: { status_class: 'none', event_type: 'invoice.paid' },
      },
    ])
  })

  it('records an automatic pause by reason only', async () => {
    const { meter, recorded } = fakeMeter()
    await createOtelHooks({ meter }).onEndpointPaused?.({
      scope: { type: 'user', id: 'user_1' },
      endpointId: 'endpoint_1',
      reason: 'failing',
    })
    expect(recorded).toEqual([
      { name: 'good_webhooks.endpoint.pauses', value: 1, attributes: { reason: 'failing' } },
    ])
  })
})
