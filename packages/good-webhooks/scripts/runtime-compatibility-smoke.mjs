import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHmac } from 'node:crypto'
import { parseWebhook } from 'good-webhooks/verify'

const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
const timestamp = 1_614_265_330
const now = new Date(timestamp * 1000)
const event = {
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  type: 'good-webhooks.test',
  occurredAt: now.toISOString(),
  data: { endpointId: 'ep_1' },
}
const body = JSON.stringify(event)
const signature = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
  .update(`${event.id}.${timestamp}.`)
  .update(body)
  .digest('base64')
const headers = {
  'webhook-id': event.id,
  'webhook-timestamp': String(timestamp),
  'webhook-signature': `v1,${signature}`,
}
const request = { body, headers, secret, now, events: {} }

assert.deepStrictEqual(await parseWebhook(request), event)
await assert.rejects(
  parseWebhook({ ...request, body: JSON.stringify({ ...event, data: { endpointId: 'ep_2' } }) }),
  (error) => error?.code === 'SIGNATURE_INVALID',
)
