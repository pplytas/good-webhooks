import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Config } from '../src/config.ts'
import { makePool } from '../src/runtime.ts'

export async function migrate(config: Config) {
  const pool = makePool(config)
  const client = await pool.connect()
  const schema = `"${config.schema}"`
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `northstar-migrations:${config.schema}`,
    ])
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.app_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    )
    for (const name of ['001-app.sql', '002-good-webhooks-alpha.2.sql']) {
      const source = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')
      const checksum = createHash('sha256').update(source).digest('hex')
      const existing = await client.query(
        `SELECT checksum FROM ${schema}.app_migrations WHERE name = $1`,
        [name],
      )
      if (existing.rows.length) {
        if (existing.rows[0].checksum !== checksum)
          throw new Error(`Applied migration ${name} changed. Restore it and add a new migration.`)
        continue
      }
      await client.query(source.replaceAll('"northstar"', schema))
      await client.query(`INSERT INTO ${schema}.app_migrations (name, checksum) VALUES ($1, $2)`, [
        name,
        checksum,
      ])
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}
