import { z } from 'zod'

// Shared validators describe transmitted values. Normalize domain inputs before publication.
export const events = {
  'invoice.paid': z.object({ invoiceId: z.string(), amount: z.number().int().nonnegative() }),
}
