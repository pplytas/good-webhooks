import { z } from 'zod'

export const products = [
  { sku: 'TRAIL-PACK', name: 'Trail daypack', unitPriceCents: 7900 },
  { sku: 'CAMP-MUG', name: 'Enamel camp mug', unitPriceCents: 1800 },
  { sku: 'FIELD-NOTES', name: 'Field notebook', unitPriceCents: 1200 },
]
export const events = {
  'order.placed': z.object({
    orderId: z.uuid(),
    customer: z.string().min(1).max(100),
    sku: z.string().min(1),
    quantity: z.number().int().positive(),
    totalCents: z.number().int().positive(),
  }),
}
export const orderInput = z
  .object({
    customer: z.string().trim().min(1).max(100),
    sku: z
      .string()
      .refine((sku) => products.some((product) => product.sku === sku), 'Unknown product'),
    quantity: z.number().int().min(1).max(100),
    idempotencyKey: z
      .string()
      .min(8)
      .max(100)
      .regex(/^[a-zA-Z0-9_-]+$/),
    rollback: z.boolean().optional().default(false),
  })
  .strict()
