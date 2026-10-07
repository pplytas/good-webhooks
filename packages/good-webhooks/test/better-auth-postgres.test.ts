import { once } from 'node:events'
import { createServer } from 'node:http'
import { Pool } from 'pg'
import { PostgresDialect } from 'kysely'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { afterAll, expect, it } from 'vitest'
import { z } from 'zod'
import { goodWebhooks, createBetterAuthManagement } from '../src/better-auth/index.js'
import { verifyWebhook } from '../src/crypto.js'
import { createDelivery } from '../src/delivery.js'
import { getPostgresMigration } from '../src/migrations.js'
import { closeDatabase, dropWebhookTables, pool } from './db.js'

afterAll(closeDatabase)

const connectionString =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:webhooks_dev_only@127.0.0.1:55439/webhooks'
const decoySchema = 'gw_ba_namespace_decoy'
const authTables = [
  'ba_namespace_account',
  'ba_namespace_session',
  'ba_namespace_user',
  'ba_namespace_verification',
  'webhookEndpoint',
]
const deliveryTables = [
  'webhook_attempts',
  'webhook_deliveries',
  'webhook_events',
  'webhook_endpoint_state',
  'webhook_schema_version',
]
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`

const cases = [
  { name: 'default public namespace', managementSchema: undefined, deliverySchema: undefined },
  {
    name: 'one shared custom namespace',
    managementSchema: 'gw_ba_namespace_shared',
    deliverySchema: 'gw_ba_namespace_shared',
  },
  {
    name: 'separate management and delivery namespaces',
    managementSchema: 'gw_ba_namespace_auth',
    deliverySchema: 'gw_ba_namespace_delivery',
  },
] as const

for (const configuration of cases) {
  it(`uses authenticated BA PostgreSQL management and signed delivery in ${configuration.name}`, async () => {
    const managementSchema = configuration.managementSchema ?? 'public'
    const deliverySchema = configuration.deliverySchema ?? 'public'
    const namespaces = [...new Set(['public', managementSchema, deliverySchema, decoySchema])]
    const allTables = [...authTables, ...deliveryTables]

    async function cleanup() {
      await dropWebhookTables(pool)
      for (const namespace of namespaces) {
        await pool.query(
          `DROP TABLE IF EXISTS ${allTables.map((table) => `${quote(namespace)}.${quote(table)}`).join(', ')} CASCADE`,
        )
        // Only our named fixture schemas are removed. Never drop the public schema.
        if (namespace !== 'public') await pool.query(`DROP SCHEMA IF EXISTS ${quote(namespace)}`)
      }
    }

    await cleanup()
    await pool.query(`CREATE SCHEMA ${quote(decoySchema)}`)
    for (const table of allTables) {
      // Any accidental unqualified query finds the wrong shape and fails.
      await pool.query(`CREATE TABLE ${quote(decoySchema)}.${quote(table)} (unexpected text)`)
    }
    const appPool = new Pool({
      connectionString,
      max: 4,
      connectionTimeoutMillis: 3000,
      ...(configuration.managementSchema === undefined
        ? { options: '-c search_path=public' }
        : { options: `-c search_path=${decoySchema}` }),
    })
    const deliveryPool = new Pool({
      connectionString,
      max: 4,
      connectionTimeoutMillis: 3000,
      options: `-c search_path=${decoySchema}`,
    })
    const received: string[] = []
    let signingSecret = ''
    const receiver = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const body = Buffer.concat(chunks)
        verifyWebhook({ body, headers: request.headers, secret: signingSecret })
        received.push(body.toString())
        response.writeHead(204).end()
      } catch {
        response.writeHead(400).end()
      }
    })
    receiver.listen(0, '127.0.0.1')
    await once(receiver, 'listening')

    try {
      const createAuth = () =>
        betterAuth({
          baseURL: 'http://localhost:3000',
          secret: 'a-shared-test-only-better-auth-encryption-secret',
          logger: { disabled: true },
          emailAndPassword: { enabled: true },
          user: { modelName: 'ba_namespace_user' },
          session: { modelName: 'ba_namespace_session' },
          account: { modelName: 'ba_namespace_account' },
          verification: { modelName: 'ba_namespace_verification' },
          database:
            configuration.managementSchema === undefined
              ? appPool
              : {
                  dialect: new PostgresDialect({ pool: appPool }),
                  type: 'postgres',
                  schemaName: configuration.managementSchema,
                },
          plugins: [goodWebhooks({ eventTypes: ['invoice.paid'], allowLocalhost: true })],
        })
      const appAuth = createAuth()
      await (await getMigrations(appAuth.options)).runMigrations()
      await deliveryPool.query(
        getPostgresMigration({
          component: 'delivery',
          ...(configuration.deliverySchema === undefined
            ? {}
            : { schema: configuration.deliverySchema }),
        }),
      )
      const placement = await pool.query<{ table_schema: string; table_name: string }>(
        `SELECT table_schema, table_name FROM information_schema.tables
         WHERE table_schema=ANY($1::text[]) AND table_name=ANY($2::text[])`,
        [namespaces.filter((namespace) => namespace !== decoySchema), allTables],
      )
      expect(placement.rows.map((row) => `${row.table_schema}.${row.table_name}`).sort()).toEqual(
        [
          ...authTables.map((table) => `${managementSchema}.${table}`),
          ...deliveryTables.map((table) => `${deliverySchema}.${table}`),
        ].sort(),
      )
      expect(
        (await pool.query("SELECT to_regclass('public.webhook_endpoints') AS table_name")).rows[0]
          .table_name,
      ).toBeNull()

      const signUp = await appAuth.api.signUpEmail({
        body: {
          name: 'Alice',
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
        },
        asResponse: true,
      })
      expect(signUp.status).toBe(200)
      const { user } = (await signUp.json()) as { user: { id: string } }
      const headers = new Headers({
        cookie: signUp.headers
          .getSetCookie()
          .map((cookie) => cookie.split(';')[0])
          .join('; '),
      })
      const address = receiver.address() as { port: number }
      const created = await appAuth.api.createWebhookEndpoint({
        headers,
        body: { url: `http://127.0.0.1:${address.port}/hook`, eventTypes: ['invoice.paid'] },
      })
      signingSecret = created.secret
      // A fresh BA context supplies the worker's trusted provider, without an HTTP listener or session.
      const management = await createBetterAuthManagement(createAuth())
      const engine = createDelivery({
        database: deliveryPool,
        source: management.source,
        events: { 'invoice.paid': z.object({ invoiceId: z.string() }) },
        allowLocalhost: true,
        ...(configuration.deliverySchema === undefined
          ? {}
          : { schema: configuration.deliverySchema }),
      })
      await engine.check()
      const scoped = engine.forScope({ type: 'user', id: user.id })
      const publication = await scoped.publish({
        type: 'invoice.paid',
        data: { invoiceId: 'invoice-1' },
      })
      expect(publication.deliveryCount).toBe(1)
      expect((await engine.worker.tick()).succeeded).toBe(1)
      expect(received).toHaveLength(1)
      expect(JSON.parse(received[0]!).data).toEqual({ invoiceId: 'invoice-1' })
      const [delivery] = (await scoped.deliveries.list()).items
      expect(delivery!.endpointId).toBe(created.endpoint.id)
      expect((await scoped.deliveries.get(delivery!.id)).attempts).toHaveLength(1)
      for (const table of allTables) {
        const result = await pool.query(
          `SELECT count(*)::integer AS count FROM ${quote(decoySchema)}.${quote(table)}`,
        )
        expect(result.rows[0].count).toBe(0)
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        receiver.close((error) => (error ? reject(error) : resolve())),
      )
      await appPool.end()
      await deliveryPool.end()
      await cleanup()
    }
  })
}
