import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { afterAll, expect, it } from 'vitest'
import { z } from 'zod'
import { goodWebhooks, createBetterAuthManagement } from '../src/better-auth/index.js'
import { createDelivery } from '../src/delivery.js'
import { verifyWebhook } from '../src/crypto.js'
import { closeDatabase, pool } from './db.js'

afterAll(closeDatabase)

it('delivers from a separate BA provider using SQLite management and only PostgreSQL delivery tables', async () => {
  await pool.query('DROP SCHEMA IF EXISTS webhooks CASCADE')
  await pool.query('DROP SCHEMA IF EXISTS webhooks_management CASCADE')
  await pool.query(await readFile(new URL('../migrations/delivery.sql', import.meta.url), 'utf8'))
  const directory = await mkdtemp(join(tmpdir(), 'good-webhooks-provider-'))
  const appDatabase = new DatabaseSync(join(directory, 'auth.sqlite'))
  const workerDatabase = new DatabaseSync(join(directory, 'auth.sqlite'))
  const events = { 'invoice.paid': z.object({ invoiceId: z.string() }) }
  const configuration = {
    baseURL: 'http://localhost:3000',
    secret: 'a-shared-test-only-better-auth-encryption-secret',
    logger: { disabled: true },
    emailAndPassword: { enabled: true },
    plugins: [goodWebhooks({ eventTypes: ['invoice.paid'], allowLocalhost: true })],
  }
  const received: string[] = []
  let signingSecret = ''
  const server = createServer(async (request, response) => {
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
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const appAuth = betterAuth({ ...configuration, database: appDatabase })
    await (await getMigrations(appAuth.options)).runMigrations()
    const response = await appAuth.api.signUpEmail({
      body: { name: 'Alice', email: 'alice@example.com', password: 'correct-horse-battery-staple' },
      asResponse: true,
    })
    expect(response.status).toBe(200)
    const { user } = (await response.json()) as { user: { id: string } }
    const headers = new Headers({
      cookie: response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';')[0])
        .join('; '),
    })
    const address = server.address() as { port: number }
    const created = await appAuth.api.createWebhookEndpoint({
      headers,
      body: { url: `http://127.0.0.1:${address.port}/webhooks`, eventTypes: ['invoice.paid'] },
    })
    signingSecret = created.secret
    // A separate auth instance and DB connection read the same authoritative records.
    // No user session or HTTP listener is passed into the worker provider.
    const workerAuth = betterAuth({ ...configuration, database: workerDatabase })
    const management = await createBetterAuthManagement(workerAuth)
    const engine = createDelivery({
      database: pool,
      source: management.source,
      events,
      allowLocalhost: true,
    })
    await engine.check()
    const scope = { type: 'user', id: user.id }
    const scoped = engine.forScope(scope)
    await appAuth.api.pauseWebhookEndpoint({ headers, body: { id: created.endpoint.id } })
    const publication = await scoped.publish({
      type: 'invoice.paid',
      data: { invoiceId: 'invoice-1' },
    })
    expect(publication.deliveryCount).toBe(1)
    expect((await engine.worker.tick()).claimed).toBe(0)
    expect(received).toHaveLength(0)
    const rotated = await appAuth.api.rotateWebhookEndpointSecret({
      headers,
      body: { id: created.endpoint.id, graceMs: 0 },
    })
    signingSecret = rotated.secret
    await appAuth.api.resumeWebhookEndpoint({ headers, body: { id: created.endpoint.id } })
    await pool.query("UPDATE webhooks.deliveries SET next_attempt_at=now() WHERE status='pending'")
    expect((await engine.worker.tick()).succeeded).toBe(1)
    expect(JSON.parse(received[0]!).data).toEqual({ invoiceId: 'invoice-1' })
    const [delivery] = (await scoped.deliveries.list()).items
    expect((await scoped.deliveries.get(delivery!.id)).attempts).toHaveLength(1)
    expect(
      (await pool.query("SELECT to_regnamespace('webhooks_management') AS schema")).rows[0].schema,
    ).toBeNull()
    const tables = appDatabase
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name)
    expect(tables).toContain('webhookEndpoint')
    expect(tables).not.toContain('deliveries')
    expect(tables).not.toContain('attempts')
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    appDatabase.close()
    workerDatabase.close()
    await rm(directory, { recursive: true, force: true })
  }
})
