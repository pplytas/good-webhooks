import { generateEncryptionKey } from 'good-webhooks'
import { access, writeFile } from 'node:fs/promises'
import { loadEnvFile } from 'node:process'
import { defaultDatabaseUrl, readConfig } from '../src/config.ts'
import { createRuntime } from '../src/runtime.ts'
import { migrate } from './migrate.ts'

try {
  try {
    await access('.env')
  } catch {
    const values = {
      DATABASE_URL: process.env.DATABASE_URL ?? defaultDatabaseUrl,
      WEBHOOK_ENCRYPTION_KEY: process.env.WEBHOOK_ENCRYPTION_KEY ?? generateEncryptionKey(),
      APP_PORT: process.env.APP_PORT ?? '4311',
      RECEIVER_PORT: process.env.RECEIVER_PORT ?? '4411',
      APP_SCHEMA: process.env.APP_SCHEMA ?? 'northstar',
    }
    await writeFile(
      '.env',
      Object.entries(values)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join('\n') + '\n',
      { mode: 0o600, flag: 'wx' },
    )
    console.log(
      'Created .env with a persistent encryption key. Keep it while retaining the database.',
    )
  }
  loadEnvFile('.env')
  const config = readConfig()
  await migrate(config)
  const runtime = createRuntime(config)
  try {
    await runtime.webhooks.check()
  } finally {
    await runtime.pool.end()
  }
  console.log(`Database ready. Start with npm run dev and open http://127.0.0.1:${config.appPort}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Setup failed')
  process.exitCode = 1
}
