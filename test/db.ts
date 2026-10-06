import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import type { ResolvedConfig } from '../src/types.js'

export const pool = new Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ??
    'postgres://postgres:webhooks_dev_only@127.0.0.1:55439/webhooks',
  max: 10,
  connectionTimeoutMillis: 3000,
})

/** Dedicated disposable test database only. Never set TEST_DATABASE_URL to a production database. */
export async function resetDatabase(): Promise<void> {
  const migration = await readFile(
    new URL('../migrations/001-initial.sql', import.meta.url),
    'utf8',
  )
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DROP SCHEMA IF EXISTS webhooks CASCADE')
    await client.query(migration)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function closeDatabase(): Promise<void> {
  await pool.end()
}

export function testConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    database: pool,
    encryptionKey: new Uint8Array(32).fill(7),
    retryDelaysMs: [10, 20],
    maxAgeMs: 60_000,
    timeoutMs: 1000,
    concurrency: 2,
    leaseMs: 5000,
    maxResponseBytes: 1024,
    retentionMs: 86_400_000,
    allowLocalhost: true,
    ...overrides,
  }
}
