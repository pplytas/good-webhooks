import { z } from 'zod'

export const defaultDatabaseUrl =
  'postgres://postgres:northstar_local_only@127.0.0.1:55441/commerce'
const envSchema = z.object({
  DATABASE_URL: z.url(),
  WEBHOOK_ENCRYPTION_KEY: z
    .string()
    .refine(
      (key) => Buffer.from(key, 'base64').length === 32,
      'Expected a base64-encoded 32-byte key',
    ),
  APP_PORT: z.coerce.number().int().min(1).max(65535).default(4311),
  RECEIVER_PORT: z.coerce.number().int().min(1).max(65535).default(4411),
  APP_SCHEMA: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,47}$/)
    .default('northstar'),
})
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = envSchema.safeParse(env)
  if (!result.success)
    throw new Error(
      'Invalid configuration. Run npm run setup and check .env. ' +
        result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    )
  const config = result.data
  if (config.APP_PORT === config.RECEIVER_PORT)
    throw new Error('APP_PORT and RECEIVER_PORT must differ.')
  return {
    databaseUrl: config.DATABASE_URL,
    encryptionKey: config.WEBHOOK_ENCRYPTION_KEY,
    appPort: config.APP_PORT,
    receiverPort: config.RECEIVER_PORT,
    schema: config.APP_SCHEMA,
    warehouseUrl: `http://127.0.0.1:${config.RECEIVER_PORT}/webhooks`,
  }
}
export type Config = ReturnType<typeof readConfig>
