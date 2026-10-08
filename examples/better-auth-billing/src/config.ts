import { z } from 'zod'

const settings = z
  .object({
    DATABASE_URL: z.url(),
    APP_PORT: z.coerce.number().int().min(1024).max(65535).default(4312),
    RECEIVER_PORT: z.coerce.number().int().min(1024).max(65535).default(4412),
    BETTER_AUTH_SECRET: z.string().min(32),
    RECEIVER_ENCRYPTION_KEY: z
      .string()
      .refine((s) => Buffer.from(s, 'base64').length === 32, 'Expected a base64 32-byte key'),
  })
  .parse(process.env)
if (settings.APP_PORT === settings.RECEIVER_PORT)
  throw new Error('App and receiver ports must differ')
const dbUrl = new URL(settings.DATABASE_URL)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(dbUrl.hostname)) {
  throw new Error('This local example requires a loopback PostgreSQL host')
}
export const config = {
  ...settings,
  appOrigin: `http://127.0.0.1:${settings.APP_PORT}`,
  receiverOrigin: `http://127.0.0.1:${settings.RECEIVER_PORT}`,
}
