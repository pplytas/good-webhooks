import { Pool, type PoolClient } from 'pg'
import { config } from './config.ts'
export function createPool() {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 8,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 11_000,
    idle_in_transaction_session_timeout: 15_000,
  })
  pool.on('error', (error) => {
    console.error('Unexpected idle database connection error:', error.message)
  })
  return pool
}
export async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
