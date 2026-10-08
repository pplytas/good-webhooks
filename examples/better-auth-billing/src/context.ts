import { createBetterAuthManagement } from 'good-webhooks/better-auth'
import { createDelivery } from 'good-webhooks/delivery'
import { createPool } from './database.ts'
import { createAuth } from './auth.ts'
import { events } from './events.ts'
export async function createContext() {
  const pool = createPool()
  try {
    const auth = createAuth(pool)
    const management = await createBetterAuthManagement(auth)
    const delivery = createDelivery({
      database: pool,
      events,
      source: management.source,
      allowLocalhost: true,
      retry: { delaysMs: [1_000, 3_000], maxAgeMs: 60_000 },
      delivery: { timeoutMs: 2_000, leaseMs: 10_000 },
    })
    await delivery.check()
    return { pool, auth, management, delivery }
  } catch (error) {
    await pool.end()
    throw error
  }
}
export type Context = Awaited<ReturnType<typeof createContext>>
