import { readFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { Pool } from 'pg'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createWebhooks, verifyWebhook } from '../src/index.js'
import { createPostgresManagement } from '../src/management/postgres.js'
import { getPostgresMigration } from '../src/migrations.js'
import { postgresTables, quotePostgresSchema } from '../src/postgres-schema.js'
import { closeDatabase, pool, resetDatabase, TEST_ENCRYPTION_KEY } from './db.js'

const database = new Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ??
    'postgres://postgres:webhooks_dev_only@127.0.0.1:55439/webhooks',
  // Every library table must be qualified, regardless of the connection's search path.
  options: '-c search_path=pg_catalog',
})
const schemas = ['Webhook "Shared"', 'Webhook Management', 'Webhook Delivery']
async function cleanup() {
  for (const schema of schemas)
    await pool.query(`DROP SCHEMA IF EXISTS ${quotePostgresSchema(schema)} CASCADE`)
}
beforeEach(async () => {
  await cleanup()
  await resetDatabase()
})
afterAll(async () => {
  await cleanup()
  await database.end()
  await closeDatabase()
})

describe('PostgreSQL schema configuration', () => {
  it('ships the same default migrations as the generator', async () => {
    for (const [file, component] of [
      ['001-initial', 'all'],
      ['management', 'management'],
      ['delivery', 'delivery'],
    ] as const) {
      const sql = await readFile(new URL(`../migrations/${file}.sql`, import.meta.url), 'utf8')
      expect(sql).toBe(getPostgresMigration({ component }))
    }
  })

  it('rejects invalid namespaces before generating SQL or connecting', () => {
    for (const schema of [
      '',
      ' ',
      'a\0b',
      'a'.repeat(64),
      '界'.repeat(22),
      'hooks\ud800',
      'hooks\udc00',
      null,
      7,
    ]) {
      const options = { schema } as { schema: string }
      expect(() => getPostgresMigration(options)).toThrow(/schema/)
      expect(() =>
        createWebhooks({
          ...options,
          database,
          encryptionKey: TEST_ENCRYPTION_KEY,
          events: { 'invoice.paid': z.object({ id: z.string() }) },
        }),
      ).toThrow(/schema/)
    }
  })

  it.each(['shared', 'separate'] as const)(
    'runs management and delivery in %s custom schemas',
    async (layout) => {
      const managementSchema = layout === 'shared' ? schemas[0]! : schemas[1]!
      const deliverySchema = layout === 'shared' ? schemas[0]! : schemas[2]!
      const client = await database.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          getPostgresMigration({ schema: managementSchema, component: 'management' }),
        )
        await client.query(getPostgresMigration({ schema: deliverySchema, component: 'delivery' }))
        await client.query('COMMIT')
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }

      let signingSecret = ''
      let received = 0
      const server = createServer(async (request, response) => {
        try {
          const chunks: Buffer[] = []
          for await (const chunk of request) chunks.push(Buffer.from(chunk))
          verifyWebhook({
            body: Buffer.concat(chunks),
            headers: request.headers,
            secret: signingSecret,
          })
          received++
          response.writeHead(204).end()
        } catch {
          response.writeHead(400).end()
        }
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      try {
        const management = createPostgresManagement({
          database,
          schema: managementSchema,
          encryptionKey: TEST_ENCRYPTION_KEY,
          eventTypes: ['invoice.paid'],
          allowLocalhost: true,
        })
        const app = createWebhooks({
          database,
          schema: deliverySchema,
          encryptionKey: TEST_ENCRYPTION_KEY,
          ...(layout === 'separate' ? { management } : {}),
          events: { 'invoice.paid': z.object({ id: z.string() }) },
          allowLocalhost: true,
        })
        await management.check()
        await app.check()
        const scope = { type: 'user', id: 'same-owner' }
        const user = app.forScope(scope)
        const { port } = server.address() as { port: number }
        const { endpoint } = await user.endpoints.create({
          url: `http://127.0.0.1:${port}/webhooks`,
          eventTypes: ['invoice.paid'],
        })
        await user.endpoints.update(endpoint.id, { description: 'configured schema' })
        expect((await user.endpoints.get(endpoint.id)).description).toBe('configured schema')
        expect(await user.endpoints.list()).toHaveLength(1)
        signingSecret = (await user.endpoints.rotateSecret(endpoint.id, { graceMs: 0 })).secret
        expect(await management.reencrypt(scope)).toBe(1)
        await user.endpoints.pause(endpoint.id)
        await user.endpoints.resume(endpoint.id)
        await user.deliverySettings.set(endpoint.id, { maxInFlight: 1 })
        expect(await user.deliverySettings.get(endpoint.id)).toEqual({ maxInFlight: 1 })
        const input = {
          type: 'invoice.paid',
          data: { id: 'inv_123' },
          idempotencyKey: 'same-key',
        } as const
        expect((await user.publish(input)).deliveryCount).toBe(1)
        expect((await user.publish(input)).duplicate).toBe(true)
        expect((await app.worker.tick()).succeeded).toBe(1)
        const [delivery] = (await user.deliveries.list()).items
        expect((await user.deliveries.get(delivery!.id)).attempts).toHaveLength(1)
        await user.deliveries.replay(delivery!.id)
        expect((await app.worker.tick()).succeeded).toBe(1)
        expect(received).toBe(2)
        await user.endpoints.remove(endpoint.id)
        expect(await user.endpoints.list()).toEqual([])
        await database.query(
          `UPDATE ${postgresTables(deliverySchema).events} SET created_at=now()-interval '8 days'`,
        )
        expect(await app.worker.prune()).toBe(1)
        expect((await user.deliveries.list()).items).toEqual([])

        // Default tables are a decoy: the configured installation must not touch them.
        expect((await pool.query('SELECT * FROM public.webhook_endpoints')).rows).toEqual([])
        expect((await pool.query('SELECT * FROM public.webhook_events')).rows).toEqual([])
        expect((await database.query('SHOW search_path')).rows[0].search_path).toBe('pg_catalog')
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      }
    },
  )
})
