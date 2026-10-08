import type { Database, SqlClient } from 'good-webhooks'
import { createDelivery, type EndpointSource } from 'good-webhooks/delivery'
import { z } from 'zod'

export const events = {
  'invoice.paid': z.object({
    invoiceId: z.string(),
    amount: z.number().int().nonnegative(),
    currency: z.string(),
  }),
}
export const deliverySchema = 'public'

/** The host authorizes the organization and supplies a client inside BEGIN. */
export async function recordInvoicePayment(options: {
  database: Database
  pgClient: SqlClient
  source: EndpointSource
  organizationId: string
  invoiceId: string
}) {
  const { database, pgClient, source, organizationId, invoiceId } = options
  const scope = Object.freeze({ type: 'organization', id: organizationId })
  const invoice = await pgClient.query<{
    invoice_id: string
    amount: number
    currency: string
  }>(
    `UPDATE transaction_example.invoices SET paid = true
     WHERE organization_id = $1 AND invoice_id = $2
     RETURNING invoice_id, amount, currency`,
    [organizationId, invoiceId],
  )
  const row = invoice.rows[0]
  if (!row) throw new Error('Invoice not found in the authorized organization.')
  const data = { invoiceId: row.invoice_id, amount: row.amount, currency: row.currency }

  // Host-owned routes define eligible endpoints for this payload, including paused endpoints.
  // The host must check endpoint ownership when creating routes. Lookup errors must reject.
  const selected = await pgClient.query<{ endpoint_id: string }>(
    `SELECT endpoint_id FROM transaction_example.invoice_routes
     WHERE organization_id = $1 AND currency = $2 AND minimum_amount <= $3
     ORDER BY endpoint_id`,
    [organizationId, data.currency, data.amount],
  )
  const recipientIds = Object.freeze(selected.rows.map(({ endpoint_id }) => endpoint_id))
  const publicationSource: EndpointSource = {
    async matchRecipients(requestedScope, eventType) {
      if (
        requestedScope?.type !== scope.type ||
        requestedScope.id !== scope.id ||
        eventType !== 'invoice.paid'
      )
        throw new Error('This recipient selection belongs to one scope and event type.')
      return recipientIds
    },
    // Resolution still uses current management state, never this transaction's client.
    resolveEndpoint: (requestedScope, id) => source.resolveEndpoint(requestedScope, id),
  }

  // Construction opens no connections and starts no worker. Never mutate a shared source.
  const publication = createDelivery({
    database,
    schema: deliverySchema,
    events,
    source: publicationSource,
  })
  // The result is provisional until the caller commits. On retry, call this function again
  // inside a fresh transaction so it repeats the business reads and recipient selection.
  return publication
    .forScope(scope)
    .publish(
      { type: 'invoice.paid', data, idempotencyKey: `invoice.paid:${invoiceId}` },
      { transaction: pgClient },
    )
}
