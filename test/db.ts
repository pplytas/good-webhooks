import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { createPostgresManagement } from '../src/management/postgres.js'
import { scopeKey } from '../src/scope.js'
import { createStore } from '../src/store.js'
import type { Database, ResolvedConfig, SqlClient } from '../src/types.js'

export const pool = new Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ??
    'postgres://postgres:webhooks_dev_only@127.0.0.1:55439/webhooks',
  max: 10,
  connectionTimeoutMillis: 3000,
})
export const TEST_ENCRYPTION_KEY = new Uint8Array(32).fill(7)
export const testScopeKey = (id: string) => scopeKey({ type: 'test', id })

/** Dedicated disposable test database only. Never set TEST_DATABASE_URL to a production database. */
export async function dropWebhookTables(database: SqlClient = pool): Promise<void> {
  await database.query(`DROP TABLE IF EXISTS public.webhook_attempts, public.webhook_deliveries,
    public.webhook_events, public.webhook_endpoint_state, public.webhook_endpoints,
    public.webhook_schema_version CASCADE`)
}

export async function resetDatabase(): Promise<void> {
  const migration = await readFile(
    new URL('../migrations/001-initial.sql', import.meta.url),
    'utf8',
  )
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await dropWebhookTables(client)
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

export function testManagement(options: { database?: Database; encryptionKey?: Uint8Array } = {}) {
  return createPostgresManagement({
    database: options.database ?? pool,
    encryptionKey: options.encryptionKey ?? TEST_ENCRYPTION_KEY,
    eventTypes: ['order.created', 'order.updated', 'test.sent', 'invoice.paid'],
    allowLocalhost: true,
  })
}

export function testConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    database: pool,
    schema: 'public',
    source: testManagement().source,
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

/** Compose the two real modules for legacy integration fixtures, using one named test scope. */
export function testStore(config: ResolvedConfig = testConfig()) {
  const management = testManagement({ database: config.database })
  const delivery = createStore(config)
  const scope = (id: string) => ({ type: 'test', id })
  return {
    checkSchema: delivery.checkSchema,
    createEndpoint: (id: string, input: Parameters<typeof management.create>[1]) =>
      management.create(scope(id), input),
    listEndpoints: (id: string) => management.list(scope(id)),
    getEndpoint: (id: string, endpointId: string) => management.get(scope(id), endpointId),
    updateEndpoint: (
      id: string,
      endpointId: string,
      patch: Parameters<typeof management.update>[2],
    ) => management.update(scope(id), endpointId, patch),
    pauseEndpoint: (id: string, endpointId: string) => management.pause(scope(id), endpointId),
    resumeEndpoint: (id: string, endpointId: string) => management.resume(scope(id), endpointId),
    removeEndpoint: (id: string, endpointId: string) => management.remove(scope(id), endpointId),
    rotateSecret: (id: string, endpointId: string, options?: { graceMs?: number }) =>
      management.rotateSecret(scope(id), endpointId, options),
    publish: (
      id: string,
      input: Parameters<typeof delivery.publish>[1],
      options?: Parameters<typeof delivery.publish>[2],
    ) => delivery.publish(testScopeKey(id), input, options),
    listDeliveries: (id: string, query?: Parameters<typeof delivery.listDeliveries>[1]) =>
      delivery.listDeliveries(testScopeKey(id), query),
    getDelivery: (id: string, deliveryId: string) =>
      delivery.getDelivery(testScopeKey(id), deliveryId),
    replay: (id: string, deliveryId: string) => delivery.replay(testScopeKey(id), deliveryId),
    getEndpointDeliveryOptions: (id: string, endpointId: string) =>
      delivery.getEndpointDeliveryOptions(testScopeKey(id), endpointId),
    setEndpointDeliveryOptions: (
      id: string,
      endpointId: string,
      options: { maxInFlight: number },
    ) => delivery.setEndpointDeliveryOptions(testScopeKey(id), endpointId, options),
  }
}
