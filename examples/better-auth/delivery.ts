import { z } from 'zod'
import { createBetterAuthManagement } from 'good-webhooks/better-auth'
import { createDelivery } from 'good-webhooks/delivery'
import type { Database } from 'good-webhooks'
import type { ExampleAuth } from './auth.js'

const events = {
  'invoice.created': z.object({ invoiceId: z.string(), total: z.number().nonnegative() }),
  'invoice.paid': z.object({ invoiceId: z.string() }),
}

/** The supplied PostgreSQL database stores delivery work, while BA keeps its SQLite database. */
export async function createExampleDelivery(auth: ExampleAuth, deliveryDatabase: Database) {
  const management = await createBetterAuthManagement(auth)
  return createDelivery({ database: deliveryDatabase, events, source: management.source })
}

/** Call only after the application authorizes the organization and commits its business write. */
export async function publishInvoice(
  delivery: Awaited<ReturnType<typeof createExampleDelivery>>,
  organizationId: string,
  invoice: { invoiceId: string; total: number },
) {
  return delivery.forScope({ type: 'organization', id: organizationId }).publish({
    type: 'invoice.created',
    data: invoice,
    idempotencyKey: `invoice.created:${invoice.invoiceId}`,
  })
}
