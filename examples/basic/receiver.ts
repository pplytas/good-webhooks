import type { IncomingMessage, ServerResponse } from 'node:http'
import { WebhookError } from 'webhook-dispatch/verify'

class BodyTooLargeError extends Error {}

/** Bound HTTP input while streaming, before allocating the complete body. */
export async function readBody(request: IncomingMessage): Promise<Buffer> {
  const limit = 512 * 1024
  if (Number(request.headers['content-length']) > limit) throw new BodyTooLargeError()
  const chunks: Buffer[] = []
  let size = 0
  // Keep the socket open long enough to return 413 if the stream exceeds the limit.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > limit) throw new BodyTooLargeError()
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size)
}

/** Expected request failures are terminal. Unexpected server failures must remain retryable. */
export function respondToRequestError(error: unknown, response: ServerResponse): void {
  if (error instanceof BodyTooLargeError) {
    response.writeHead(413, { Connection: 'close' }).end('Webhook body is too large')
  } else if (
    error instanceof WebhookError &&
    ['SIGNATURE_INVALID', 'SIGNATURE_EXPIRED', 'PAYLOAD_INVALID'].includes(error.code)
  ) {
    response.writeHead(400).end('Invalid webhook')
  } else {
    respondToProcessingError(error, response)
  }
}

/** Call for business failures regardless of their error class or code. */
export function respondToProcessingError(error: unknown, response: ServerResponse): void {
  console.error('Receiver could not process the webhook:', error)
  response.writeHead(500).end('Webhook processing failed')
}
