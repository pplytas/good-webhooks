import { Pool } from 'pg'
import { z } from 'zod'
import { createWebhooks, type WebhookClient, type Scope } from '../src/index.js'
import { verifyWebhook } from '../src/verify.js'
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
