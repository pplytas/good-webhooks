export type WebhookErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_INPUT'
  | 'UNSAFE_URL'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REPLAY_IN_PROGRESS'
  | 'SCHEMA_MISMATCH'
  | 'SIGNATURE_INVALID'
  | 'SIGNATURE_EXPIRED'
  | 'PAYLOAD_INVALID'
  | 'TRANSACTION_REQUIRED'

/** Expected operation failures. Recipient failures are recorded on deliveries instead. */
export class WebhookError extends Error {
  override readonly name = 'WebhookError'
  constructor(
    readonly code: WebhookErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}
