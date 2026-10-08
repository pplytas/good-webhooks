import { z } from 'zod'
const invoice = z.object({
  invoiceId: z.uuid(),
  customer: z.string().min(1).max(120),
  total: z.number().int().positive().max(100_000_000),
  currency: z.literal('EUR'),
})
export const events = { 'invoice.created': invoice, 'invoice.paid': invoice }
