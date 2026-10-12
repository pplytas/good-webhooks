import { readFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createDelivery } from '../src/delivery.js'
import { createWebhooks } from '../src/index.js'
import { createPostgresManagement } from '../src/management/postgres.js'
import { getPostgresMigration, getPostgresUpgrade } from '../src/migrations.js'
import { quotePostgresSchema } from '../src/postgres-schema.js'
import { closeDatabase, dropWebhookTables, pool, TEST_ENCRYPTION_KEY } from './db.js'

const fixture = (name: string) =>
  readFile(new URL(`./fixtures/schema-3-${name}.sql`, import.meta.url), 'utf8')
const events = { 'invoice.paid': z.object({ id: z.string() }) }
const app = () =>
  createWebhooks({
    database: pool,
    encryptionKey: TEST_ENCRYPTION_KEY,
    events,
    allowLocalhost: true,
  })
const versions = async (schema = 'public') =>
  (
    await pool.query(
      `SELECT component, version FROM ${quotePostgresSchema(schema)}."webhook_schema_version" ORDER BY component`,
    )
  ).rows

async function apply(sql: string) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(sql)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

const customSchemas = ['upgrade_management', 'upgrade_delivery']
async function cleanup() {
  await dropWebhookTables(pool)
  for (const schema of customSchemas)
    await pool.query(`DROP SCHEMA IF EXISTS ${quotePostgresSchema(schema)} CASCADE`)
}
beforeEach(cleanup)
afterAll(async () => {
  await cleanup()
  await closeDatabase()
})

describe('schema upgrade from version 3 to 4', () => {
  it('generates upgrade SQL only for a recorded version it can upgrade', () => {
    expect(() => getPostgresUpgrade({ from: 4 })).toThrow(/current/)
    expect(() => getPostgresUpgrade({ from: 2 })).toThrow(/from must be 3/)
    expect(() => getPostgresUpgrade({ from: 3, component: 'both' as 'all' })).toThrow(/component/)
    expect(() => getPostgresUpgrade(undefined as unknown as { from: 3 })).toThrow(/from/)
    expect(getPostgresUpgrade({ from: 3, component: 'management' })).not.toContain('ALTER TABLE')
    expect(getPostgresUpgrade({ from: 3, component: 'delivery' })).not.toContain("'management'")
  })

  it('refuses to start on version 3 storage and names the upgrade', async () => {
    await apply(await fixture('all'))
    const management = createPostgresManagement({
      database: pool,
      encryptionKey: TEST_ENCRYPTION_KEY,
      eventTypes: ['invoice.paid'],
    })
    await expect(management.check()).rejects.toMatchObject({
      code: 'SCHEMA_MISMATCH',
      message: expect.stringContaining(
        'getPostgresUpgrade({ schema: "public", component: \'management\', from: 3 })',
      ),
    })
    const delivery = createDelivery({ database: pool, source: management.source, events })
    await expect(delivery.check()).rejects.toMatchObject({
      code: 'SCHEMA_MISMATCH',
      message: expect.stringContaining(
        'getPostgresUpgrade({ schema: "public", component: \'delivery\', from: 3 })',
      ),
    })
    // The composed client checks management first, so it reports that component.
    await expect(app().check()).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' })
  })

  it('upgrades a shared installation and keeps a pending backlog deliverable', async () => {
    await apply(await fixture('all'))
    let received = 0
    const server = createServer((_request, response) => {
      received++
      response.writeHead(204).end()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const { port } = server.address() as { port: number }
      // Version 3 and 4 share every table except the version record, so work queued before the upgrade is real backlog.
      const before = app().forScope({ type: 'user', id: 'owner' })
      const { endpoint } = await before.endpoints.create({
        url: `http://127.0.0.1:${port}/hook`,
        eventTypes: ['invoice.paid'],
      })
      expect(
        (await before.publish({ type: 'invoice.paid', data: { id: 'inv_1' } })).deliveryCount,
      ).toBe(1)

      await apply(getPostgresUpgrade({ from: 3 }))
      expect(await versions()).toEqual([
        { component: 'delivery', version: 4 },
        { component: 'management', version: 4 },
      ])

      const after = app()
      await after.check()
      expect((await after.worker.runOnce()).succeeded).toBe(1)
      expect(received).toBe(1)
      const user = after.forScope({ type: 'user', id: 'owner' })
      expect((await user.endpoints.get(endpoint.id)).status).toBe('active')
      expect((await user.deliveries.list()).items[0]?.status).toBe('succeeded')
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })

  it('rolls back as one unit and can be retried', async () => {
    await apply(await fixture('all'))
    const client = await pool.connect()
    try {
      await client.query('CREATE TEMP TABLE migration_ledger (name text PRIMARY KEY)')
      await client.query("INSERT INTO migration_ledger VALUES ('004')")
      await client.query('BEGIN')
      await client.query(getPostgresUpgrade({ from: 3 }))
      await expect(
        client.query("INSERT INTO migration_ledger VALUES ('004')"),
      ).rejects.toMatchObject({
        code: '23505',
      })
      await client.query('ROLLBACK')
      expect(
        (await client.query('SELECT version FROM public.webhook_schema_version')).rows,
      ).toEqual([{ version: 3 }])
      await client.query('DELETE FROM migration_ledger')
      await client.query('BEGIN')
      await client.query(getPostgresUpgrade({ from: 3 }))
      await client.query("INSERT INTO migration_ledger VALUES ('004')")
      await client.query('COMMIT')
      await app().check()
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      await client.query('DROP TABLE IF EXISTS migration_ledger')
      client.release()
    }
  })

  it('fails inside the transaction when the recorded version is not 3', async () => {
    await apply(await fixture('all'))
    await pool.query('UPDATE public.webhook_schema_version SET version = 1')
    await expect(apply(getPostgresUpgrade({ from: 3 }))).rejects.toThrow(
      /expected delivery schema version 3/,
    )
    expect((await pool.query('SELECT version FROM public.webhook_schema_version')).rows).toEqual([
      { version: 1 },
    ])
    await expect(app().check()).rejects.toMatchObject({
      code: 'SCHEMA_MISMATCH',
      message: expect.stringContaining('unsupported version 1'),
    })
  })

  it('does not apply twice', async () => {
    await apply(await fixture('all'))
    await apply(getPostgresUpgrade({ from: 3 }))
    await expect(apply(getPostgresUpgrade({ from: 3 }))).rejects.toThrow(
      /expected delivery schema version 3/,
    )
    expect(await versions()).toHaveLength(2)
  })

  it('upgrades separately installed components in their own schemas', async () => {
    const [managementSchema, deliverySchema] = customSchemas as [string, string]
    const legacyManagement = (await fixture('management')).replaceAll(
      '"public"',
      quotePostgresSchema(managementSchema),
    )
    const legacyDelivery = (await fixture('delivery')).replaceAll(
      '"public"',
      quotePostgresSchema(deliverySchema),
    )
    await apply(legacyManagement)
    await apply(legacyDelivery)
    const management = createPostgresManagement({
      database: pool,
      schema: managementSchema,
      encryptionKey: TEST_ENCRYPTION_KEY,
      eventTypes: ['invoice.paid'],
      allowLocalhost: true,
    })
    const webhooks = createWebhooks({
      database: pool,
      schema: deliverySchema,
      management,
      encryptionKey: TEST_ENCRYPTION_KEY,
      events,
      allowLocalhost: true,
    })
    await expect(management.check()).rejects.toMatchObject({
      code: 'SCHEMA_MISMATCH',
      message: expect.stringContaining('records no version'),
    })
    await expect(webhooks.check()).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' })

    await apply(getPostgresUpgrade({ from: 3, schema: managementSchema, component: 'management' }))
    await apply(getPostgresUpgrade({ from: 3, schema: deliverySchema, component: 'delivery' }))
    await management.check()
    await webhooks.check()
    expect(await versions(managementSchema)).toEqual([{ component: 'management', version: 4 }])
    expect(await versions(deliverySchema)).toEqual([{ component: 'delivery', version: 4 }])
  })

  it('refuses the management step before the delivery step in a shared schema', async () => {
    await apply(await fixture('all'))
    await expect(
      apply(getPostgresUpgrade({ from: 3, component: 'management' })),
    ).rejects.toMatchObject({
      code: '42703',
    })
    expect((await pool.query('SELECT version FROM public.webhook_schema_version')).rows).toEqual([
      { version: 3 },
    ])
  })

  it('refuses storage newer than the package and asks for a package upgrade', async () => {
    await apply(getPostgresMigration())
    await pool.query(
      "UPDATE public.webhook_schema_version SET version = 5 WHERE component = 'delivery'",
    )
    await expect(app().check()).rejects.toMatchObject({
      code: 'SCHEMA_MISMATCH',
      message: expect.stringContaining('Upgrade the good-webhooks package'),
    })
  })

  it('reports a missing component row on fresh storage installed for one component', async () => {
    await apply(getPostgresMigration({ component: 'delivery' }))
    await expect(app().check()).rejects.toMatchObject({
      code: 'SCHEMA_MISMATCH',
      message: expect.stringContaining('records no management version'),
    })
    await apply(getPostgresMigration({ component: 'management' }))
    await app().check()
    expect(await versions()).toHaveLength(2)
  })
})
