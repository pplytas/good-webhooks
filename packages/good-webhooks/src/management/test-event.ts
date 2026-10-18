import { randomUUID } from 'node:crypto'
import { signWebhook } from '../crypto.js'
import { TEST_EVENT_TYPE } from '../event-names.js'
import { sendWebhook } from '../transport.js'
import type { TestEventResult } from '../types.js'

/** The delivery defaults. A test is one interactive request, so neither is configurable yet. */
const TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 4096

/** Sign and send one test event. Receiver failures are part of the result, never thrown. */
export async function sendTestEvent(input: {
  endpointId: string
  url: string
  secrets: readonly string[]
  allowLocalhost: boolean
}): Promise<TestEventResult> {
  const eventId = randomUUID()
  const body = JSON.stringify({
    id: eventId,
    type: TEST_EVENT_TYPE,
    occurredAt: new Date().toISOString(),
    data: { endpointId: input.endpointId },
  })
  const headers = signWebhook({
    id: eventId,
    timestamp: Math.floor(Date.now() / 1000),
    body,
    secrets: input.secrets,
  })
  const started = performance.now()
  const response = await sendWebhook({
    url: input.url,
    body,
    headers,
    timeoutMs: TIMEOUT_MS,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    allowLocalhost: input.allowLocalhost,
  })
  const durationMs = Math.round(performance.now() - started)
  const { status, responseBody } = response
  const ok = response.error === null && status !== null && status >= 200 && status < 300
  return {
    eventId,
    ok,
    responseStatus: status,
    responseBody,
    durationMs,
    error: response.error ?? (ok || status === null ? null : `Receiver returned HTTP ${status}`),
  }
}
