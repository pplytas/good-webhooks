import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import type { Context } from './context.ts'
export const invoiceInput = z
  .object({
    customer: z.string().trim().min(1).max(120),
    total: z.number().int().positive().max(100_000_000),
  })
  .strict()
export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
export async function createInvoice(
  client: PoolClient,
  delivery: Context['delivery'],
  ownerId: string,
  input: z.infer<typeof invoiceInput>,
) {
  const data = { invoiceId: randomUUID(), ...input, currency: 'EUR' as const }
  const result = await client.query(
    "INSERT INTO billing_invoices (id, owner_id, customer, total, status) VALUES ($1,$2,$3,$4,'open') RETURNING *",
    [data.invoiceId, ownerId, data.customer, data.total],
  )
  const publication = await delivery
    .forScope({ type: 'user', id: ownerId })
    .publish(
      { type: 'invoice.created', data, idempotencyKey: `invoice.created:${data.invoiceId}` },
      { transaction: client },
    )
  return { invoice: result.rows[0], publication }
}
export async function payInvoice(
  client: PoolClient,
  delivery: Context['delivery'],
  ownerId: string,
  id: string,
) {
  const found = await client.query(
    'SELECT * FROM billing_invoices WHERE id = $1 AND owner_id = $2 FOR UPDATE',
    [id, ownerId],
  )
  if (!found.rowCount) throw new HttpError(404, 'Invoice not found')
  const invoice = found.rows[0]
  if (invoice.status === 'paid') throw new HttpError(409, 'Invoice is already paid')
  await client.query("UPDATE billing_invoices SET status = 'paid', paid_at = now() WHERE id = $1", [
    id,
  ])
  const publication = await delivery.forScope({ type: 'user', id: ownerId }).publish(
    {
      type: 'invoice.paid',
      data: { invoiceId: id, customer: invoice.customer, total: invoice.total, currency: 'EUR' },
      idempotencyKey: `invoice.paid:${id}`,
    },
    { transaction: client },
  )
  return { publication }
}
