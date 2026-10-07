/** Receiver-only import. Does not load database or worker code. */
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { verifySignature, type VerifyWebhookInput } from './crypto.js'
import { WebhookError } from './errors.js'
import { toJson } from './json.js'
import type { EventDefinitions } from './types.js'

export { verifyWebhook } from './crypto.js'
export { WebhookError } from './errors.js'
export type { WebhookErrorCode } from './errors.js'

/** A discriminated union of the event map's decoded output types. */
export type ParsedWebhook<E extends EventDefinitions> = {
  [K in Extract<keyof E, string>]: {
    id: string
    type: K
    occurredAt: string
    data: StandardSchemaV1.InferOutput<E[K]>
  }
}[Extract<keyof E, string>]

function payloadError(): WebhookError {
  return new WebhookError(
    'PAYLOAD_INVALID',
    'Webhook body does not match the expected event format.',
  )
}

function isPublicationTime(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const time = new Date(value)
  return Number.isFinite(time.getTime()) && time.toISOString() === value
}

/** Authenticate a Good Webhooks envelope and decode its payload with a receiver schema.
 * Enforce HTTP upload limits before buffering. This function accepts at most 512 KiB.
 * Validators accept transmitted JSON and may return local values such as Date.
 */
export async function parseWebhook<const E extends EventDefinitions>(
  input: VerifyWebhookInput & { events: E },
): Promise<ParsedWebhook<E>> {
  const { body, headers, secret, now, toleranceSeconds, events } = input
  if (typeof body !== 'string' && !(body instanceof Uint8Array)) {
    throw new WebhookError('INVALID_INPUT', 'Parse the raw request body as a string or Uint8Array.')
  }
  if ((typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength) > 524288) {
    throw payloadError()
  }
  // Copy caller-owned bytes before any header getters or asynchronous validation can mutate them.
  const bytes = Buffer.from(body)
  const verified = verifySignature({
    body: bytes,
    headers,
    secret,
    ...(now === undefined ? {} : { now }),
    ...(toleranceSeconds === undefined ? {} : { toleranceSeconds }),
  })
  let envelope: Record<string, unknown>
  let data: unknown
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    )
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !['id', 'type', 'occurredAt', 'data'].every((key) => Object.hasOwn(parsed, key))
    )
      throw payloadError()
    envelope = parsed as Record<string, unknown>
    if (
      envelope.id !== verified.id ||
      typeof envelope.type !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(envelope.type) ||
      !isPublicationTime(envelope.occurredAt)
    )
      throw payloadError()
    data = toJson(envelope.data)
  } catch {
    // JSON and validation errors may contain payload values. Never expose them as request errors.
    throw payloadError()
  }
  if (!events || typeof events !== 'object' || Array.isArray(events)) {
    throw new WebhookError('INVALID_CONFIG', 'Supply an event map of Standard Schema validators.')
  }
  const type = envelope.type as string
  if (!Object.hasOwn(events, type)) throw payloadError()
  const schema = events[type]?.['~standard']
  if (typeof schema?.validate !== 'function') {
    throw new WebhookError(
      'INVALID_CONFIG',
      'The selected event needs a Standard Schema validator.',
    )
  }
  let result: StandardSchemaV1.Result<unknown>
  try {
    result = await schema.validate(data)
    if (
      !result ||
      typeof result !== 'object' ||
      (!result.issues && !Object.hasOwn(result, 'value'))
    ) {
      throw new Error('The event validator returned an invalid result.')
    }
  } catch (cause) {
    // Even a validator-thrown WebhookError is a receiver failure, not an expected request rejection.
    throw new Error('The webhook event validator failed.', { cause })
  }
  if (result.issues) throw payloadError()
  // The own-key lookup and selected validator establish this name/output relationship at runtime.
  return {
    id: verified.id,
    type,
    occurredAt: envelope.occurredAt,
    data: result.value,
  } as ParsedWebhook<E>
}
