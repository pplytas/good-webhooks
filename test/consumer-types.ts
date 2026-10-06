import { Pool } from 'pg'
import { z } from 'zod'
import { createWebhooks, type WebhookClient, type Scope } from '../src/index.js'
import { parseWebhook, verifyWebhook, type ParsedWebhook } from '../src/verify.js'
import type { IncomingMessage } from 'node:http'

// Compiled, never executed. These assertions test the consumer's public TypeScript experience.
function consumerTypes(request: IncomingMessage) {
  verifyWebhook({ body: Buffer.from('{}'), headers: request.headers, secret: 'test-only' })
  const appEvents = {
    'order.created': z.object({ id: z.string(), total: z.number() }),
    'user.created': z.object({ email: z.email() }),
  }
  const app = createWebhooks({
    database: new Pool(),
    encryptionKey: new Uint8Array(32),
    events: appEvents,
  })
  const owner: Scope = { type: 'organization', id: 'customer-1' }
  const scoped: WebhookClient<typeof appEvents> = app.forScope(owner)
  app.publish({ type: 'order.created', data: { id: 'o1', total: 1 } })
  app.endpoints.create({ url: 'https://example.com/hook', eventTypes: ['order.created'] })
  // @ts-expect-error root inputs retain event inference
  app.publish({ type: 'order.created', data: { id: 1, total: 1 } })
  // @ts-expect-error root subscriptions retain event inference
  app.endpoints.create({ url: 'https://example.com/hook', eventTypes: ['missing'] })
  // @ts-expect-error named scopes require a namespace as well as an id
  app.forScope({ id: 'customer-1' })
  // @ts-expect-error undefined must not select the application scope
  app.forScope(undefined)
  // @ts-expect-error bound clients cannot select another scope
  scoped.forScope(owner)
  // @ts-expect-error bound clients do not expose global maintenance
  scoped.worker.tick()
  scoped.deliveries.list({ eventId: '00000000-0000-0000-0000-000000000001' })
  scoped.publish({ type: 'order.created', data: { id: 'o1', total: 1 } })
  scoped.endpoints.create({ url: 'https://example.com/hook', eventTypes: ['order.created'] })
  // @ts-expect-error event names are inferred, not arbitrary strings
  scoped.publish({ type: 'order.missing', data: {} })
  // @ts-expect-error input must match this event's schema
  scoped.publish({ type: 'order.created', data: { id: 123, total: 1 } })
  // @ts-expect-error cannot substitute another event's payload
  scoped.publish({ type: 'order.created', data: { email: 'a@example.com' } })
  // @ts-expect-error endpoint subscriptions use configured event names
  scoped.endpoints.create({ url: 'https://example.com/hook', eventTypes: ['missing'] })
}
void consumerTypes

async function receiverTypes(request: IncomingMessage) {
  const events = {
    'invoice.paid': z.object({ invoiceId: z.string(), amount: z.number() }),
    'account.activated': z.string().transform(async (value) => new Date(value)),
  }
  const event = await parseWebhook({
    body: Buffer.from('{}'),
    headers: request.headers,
    secret: 'test-only',
    events,
  })
  const typed: ParsedWebhook<typeof events> = event
  void typed
  if (event.type === 'invoice.paid') {
    const amount: number = event.data.amount
    // @ts-expect-error one event's fields cannot leak into another event's payload
    event.data.getTime()
    // @ts-expect-error the payload field remains numeric
    const invalid: string = event.data.amount
    void amount
    void invalid
  } else {
    const decoded: Date = event.data
    // @ts-expect-error decoded data uses the validator output, not its string input
    const input: string = event.data
    void decoded
    void input
  }
  const unknownEvent = {
    id: 'e',
    type: 'missing',
    occurredAt: '',
    data: new Date(),
  }
  // @ts-expect-error unknown event names cannot construct the public union
  const missing: ParsedWebhook<typeof events> = unknownEvent
  await parseWebhook({
    body: '',
    headers: request.headers,
    secret: 'test-only',
    // @ts-expect-error the receiver map requires Standard Schema validators
    events: { broken: {} },
  })
  void missing
}
void receiverTypes
