// Records delivery metrics through the OpenTelemetry API. Pass `hooks: createOtelHooks()` to
// createWebhooks() or createDelivery(). The host application configures the OpenTelemetry SDK
// and exporter. Register its MeterProvider first: meters taken earlier stay no-op.
import { metrics, type Meter } from '@opentelemetry/api'
import type { DeliveryHooks } from 'good-webhooks'

export interface OtelHooksOptions {
  /** Defaults to the global meter named `good-webhooks`. */
  meter?: Meter
  /** Prefix for instrument names. */
  prefix?: string
}

const statusClass = (status: number | null) =>
  status === null ? 'none' : `${Math.floor(status / 100)}xx`

export function createOtelHooks({
  meter = metrics.getMeter('good-webhooks'),
  prefix = 'good_webhooks',
}: OtelHooksOptions = {}): DeliveryHooks {
  const duration = meter.createHistogram(`${prefix}.attempt.duration`, {
    description: 'Duration of each delivery attempt, until the response or the failure.',
    unit: 'ms',
  })
  const attempts = meter.createCounter(`${prefix}.attempts`, {
    description: 'Delivery attempts by outcome.',
    unit: '{attempt}',
  })
  const responses = meter.createCounter(`${prefix}.attempt.responses`, {
    description: 'Delivery attempts by response status class, or none without a response.',
    unit: '{response}',
  })
  const pauses = meter.createCounter(`${prefix}.endpoint.pauses`, {
    description: 'Automatic endpoint pauses by reason.',
    unit: '{pause}',
  })
  // Attributes leave out endpoint, scope, delivery, and event IDs on purpose. Every distinct
  // value starts a new time series, so unbounded IDs would grow storage without limit.
  return {
    onAttempt: ({ eventType, outcome, responseStatus, durationMs }) => {
      duration.record(durationMs, { outcome, event_type: eventType })
      attempts.add(1, { outcome, event_type: eventType })
      responses.add(1, { status_class: statusClass(responseStatus), event_type: eventType })
    },
    onEndpointPaused: ({ reason }) => pauses.add(1, { reason }),
  }
}
