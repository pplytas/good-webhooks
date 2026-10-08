import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'

// Creating .env is an explicit setup operation, never a server startup side effect.
export function initializeEnv() {
  if (!existsSync('.env')) {
    const values = {
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://billing:billing_local_only@127.0.0.1:55442/billing',
      APP_PORT: process.env.APP_PORT ?? '4312',
      RECEIVER_PORT: process.env.RECEIVER_PORT ?? '4412',
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? randomBytes(32).toString('base64'),
      RECEIVER_ENCRYPTION_KEY:
        process.env.RECEIVER_ENCRYPTION_KEY ?? randomBytes(32).toString('base64'),
    }
    for (const [name, value] of Object.entries(values)) {
      if (/[\r\n"]/.test(value))
        throw new Error(`${name} must not contain a newline or double quote`)
    }
    const text =
      Object.entries(values)
        .map(([name, value]) => `${name}="${value}"`)
        .join('\n') + '\n'
    writeFileSync('.env', text, { flag: 'wx', mode: 0o600 })
    console.log('Created .env with persistent local secrets.')
  }
  loadEnvFile('.env')
}
export async function migrate(pool: Pool) {
  const { getMigrations } = await import('better-auth/db/migration')
  const { getPostgresMigration } = await import('good-webhooks/migrations')
  const { authOptions } = await import('./auth.ts')
  const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
  if (tables.rowCount && !tables.rows.some((r) => r.tablename === 'billing_example_metadata')) {
    throw new Error(
      'Database is not empty and has no billing-example marker. Use a new dedicated database; setup will not adopt existing tables.',
    )
  }
  await pool.query(
    'CREATE TABLE IF NOT EXISTS billing_example_metadata (name text PRIMARY KEY, value text NOT NULL)',
  )
  await (await getMigrations(authOptions(pool))).runMigrations()
  const { transaction } = await import('./database.ts')
  await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('billing-example-setup'))")
    const done = await client.query(
      "SELECT value FROM billing_example_metadata WHERE name = 'schema-version'",
    )
    if (done.rowCount) {
      if (done.rows[0].value !== '1') throw new Error('Unknown billing schema version')
      return
    }
    await client.query(getPostgresMigration({ component: 'delivery' }))
    await client.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'))
    await client.query("INSERT INTO billing_example_metadata VALUES ('schema-version', '1')")
  })
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  initializeEnv()
  const { createPool } = await import('./database.ts')
  const pool = createPool()
  try {
    await migrate(pool)
    console.log('Auth, delivery, and billing schemas are ready. Run npm run dev.')
  } finally {
    await pool.end()
  }
}
