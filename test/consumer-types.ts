import { Pool } from 'pg'
import { z } from 'zod'
import { createWebhooks } from '../src/index.js'

// Compiled, never executed. These assertions test the consumer's public TypeScript experience.
function consumerTypes() {
  const app = createWebhooks({
    database: new Pool(),
    encryptionKey: new Uint8Array(32),
    events: {
      'order.created': z.object({ id: z.string(), total: z.number() }),
      'user.created': z.object({ email: z.email() }),
    },
  })
  const tenant = app.forTenant({ id: 'customer-1' })
  tenant.publish({ type: 'order.created', data: { id: 'o1', total: 1 } })
  tenant.endpoints.create({ url: 'https://example.com/hook', eventTypes: ['order.created'] })
  // @ts-expect-error event names are inferred, not arbitrary strings
  tenant.publish({ type: 'order.missing', data: {} })
  // @ts-expect-error input must match this event's schema
  tenant.publish({ type: 'order.created', data: { id: 123, total: 1 } })
  // @ts-expect-error cannot substitute another event's payload
  tenant.publish({ type: 'order.created', data: { email: 'a@example.com' } })
  // @ts-expect-error endpoint subscriptions use configured event names
  tenant.endpoints.create({ url: 'https://example.com/hook', eventTypes: ['missing'] })
}
void consumerTypes
