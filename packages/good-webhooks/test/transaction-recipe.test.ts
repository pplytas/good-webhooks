import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDelivery } from 'good-webhooks/delivery'
import { deliverySchema, events, recordInvoicePayment } from '../examples/transactions/invoices.js'
import { closeDatabase, pool, resetDatabase, testManagement } from './db.js'

const management = testManagement()
const delivery = createDelivery({
  database: pool,
  schema: deliverySchema,
  events,
  source: management.source,
  allowLocalhost: true,
})
const organization = (id: string) => ({ type: 'organization', id })
const received: { path: string; body: { id: string; data: unknown } }[] = []
const receiver = createServer(async (request, response) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  received.push({ path: request.url!, body: JSON.parse(Buffer.concat(chunks).toString()) })
  response.end('ok')
})
let baseUrl: string

beforeAll(async () => {
  receiver.listen(0, '127.0.0.1')
  await once(receiver, 'listening')
  const address = receiver.address()
  if (!address || typeof address === 'string') throw new Error('Receiver did not bind.')
  baseUrl = `http://127.0.0.1:${address.port}`
})
beforeEach(async () => {
  await resetDatabase()
  await pool.query('DROP SCHEMA IF EXISTS transaction_example CASCADE')
  await pool.query(
    await readFile(new URL('../examples/transactions/schema.sql', import.meta.url), 'utf8'),
  )
  received.length = 0
})
afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    receiver.close((error) => (error ? reject(error) : resolve()))
    receiver.closeAllConnections()
  })
  await pool.query('DROP SCHEMA IF EXISTS transaction_example CASCADE')
  await closeDatabase()
})

async function invoice(organizationId = 'a') {
  await pool.query(
    `INSERT INTO transaction_example.invoices (organization_id, invoice_id, amount, currency)
     VALUES ($1, 'inv_1', 4200, 'EUR')`,
    [organizationId],
  )
}
async function endpoint(organizationId: string, path: string) {
  return (
    await management.create(organization(organizationId), {
      url: `${baseUrl}/${path}`,
      eventTypes: ['invoice.paid'],
    })
  ).endpoint.id
}
async function route(
  organizationId: string,
  endpointId: string,
  options: { currency?: string; minimumAmount?: number; client?: PoolClient } = {},
) {
  await (options.client ?? pool).query(
    `INSERT INTO transaction_example.invoice_routes
     (organization_id, endpoint_id, currency, minimum_amount) VALUES ($1, $2, $3, $4)`,
    [organizationId, endpointId, options.currency ?? 'EUR', options.minimumAmount ?? 0],
  )
}
function record(pgClient: PoolClient, organizationId = 'a') {
  return recordInvoicePayment({
    database: pool,
    pgClient,
    source: management.source,
    organizationId,
    invoiceId: 'inv_1',
  })
}
async function transaction<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
async function paid(organizationId = 'a') {
  return (
    await pool.query<{ paid: boolean }>(
      'SELECT paid FROM transaction_example.invoices WHERE organization_id = $1',
      [organizationId],
    )
  ).rows[0]?.paid
}
async function recipients(organizationId: string, eventId: string) {
  return (await delivery.forScope(organization(organizationId)).deliveries.list({ eventId })).items
    .map(({ endpointId }) => endpointId)
    .sort()
}

describe('caller-owned transaction and payload-dependent recipient recipe', () => {
  it('rolls back the business write and publication after a later SQL failure, then reselects on retry', async () => {
    await invoice()
    const original = await endpoint('a', 'original')
    const replacement = await endpoint('a', 'replacement')
    await route('a', original)
    let rolledBackEventId: string | undefined

    await expect(
      transaction(async (client) => {
        const publication = await record(client)
        rolledBackEventId = publication.eventId
        expect(publication).toMatchObject({ deliveryCount: 1, duplicate: false })
        expect(await paid()).toBe(false)
        expect((await pool.query('SELECT id FROM public.webhook_events')).rows).toEqual([])
        expect(await delivery.worker.runOnce()).toMatchObject({ claimed: 0 })
        // A host write fails after publish has returned successfully inside its savepoint.
        await client.query(
          `INSERT INTO transaction_example.invoices (organization_id, invoice_id, amount, currency)
           VALUES ('a', 'inv_1', 4200, 'EUR')`,
        )
      }),
    ).rejects.toMatchObject({ code: '23505' })

    expect(await paid()).toBe(false)
    expect((await pool.query('SELECT id FROM public.webhook_events')).rows).toEqual([])
    expect((await pool.query('SELECT id FROM public.webhook_deliveries')).rows).toEqual([])
    expect(received).toEqual([])

    await pool.query('DELETE FROM transaction_example.invoice_routes')
    await route('a', replacement)
    const retried = await transaction((client) => record(client))
    expect(retried).toMatchObject({ deliveryCount: 1, duplicate: false })
    expect(retried.eventId).not.toBe(rolledBackEventId)
    expect(await recipients('a', retried.eventId)).toEqual([replacement])
    expect(await paid()).toBe(true)
  })

  it('selects exact recipients from uncommitted host data and lets the normal worker resolve current endpoints', async () => {
    await invoice()
    const first = await endpoint('a', 'old-url')
    const addedInTransaction = await endpoint('a', 'added')
    const belowThreshold = await endpoint('a', 'below-threshold')
    const otherCurrency = await endpoint('a', 'other-currency')
    const foreign = await endpoint('b', 'foreign')
    await route('a', first)
    await route('a', belowThreshold, { minimumAmount: 4500 })
    await route('a', otherCurrency, { currency: 'USD' })
    await route('b', foreign)
    // Paused endpoints are still recipients. The worker uses their later lifecycle state.
    await management.pause(organization('a'), first)

    const publication = await transaction(async (client) => {
      await route('a', addedInTransaction, { minimumAmount: 4000, client })
      const pending = await record(client)
      expect(pending.deliveryCount).toBe(2)
      expect(await paid()).toBe(false)
      expect(await recipients('a', pending.eventId)).toEqual([])
      expect(await delivery.worker.runOnce()).toMatchObject({ claimed: 0 })
      return pending
    })

    expect(await paid()).toBe(true)
    expect(await recipients('a', publication.eventId)).toEqual([first, addedInTransaction].sort())
    await management.update(organization('a'), first, { url: `${baseUrl}/current-url` })
    await management.resume(organization('a'), first)
    expect(await delivery.worker.runOnce()).toMatchObject({ claimed: 2, succeeded: 2 })
    expect(received.map(({ path }) => path).sort()).toEqual(['/added', '/current-url'])
    for (const { body } of received) {
      expect(body).toMatchObject({
        id: publication.eventId,
        data: { invoiceId: 'inv_1', amount: 4200, currency: 'EUR' },
      })
    }
  })

  it('keeps the committed recipient selection on an idempotent repeat and rejects changed content', async () => {
    await invoice()
    const original = await endpoint('a', 'original')
    const later = await endpoint('a', 'later')
    await route('a', original)
    const first = await transaction((client) => record(client))

    await pool.query('DELETE FROM transaction_example.invoice_routes')
    await route('a', later)
    const duplicate = await transaction((client) => record(client))
    expect(duplicate).toEqual({ ...first, duplicate: true })
    expect(await recipients('a', first.eventId)).toEqual([original])
    expect((await pool.query('SELECT id FROM public.webhook_events')).rows).toHaveLength(1)

    await expect(
      transaction(async (client) => {
        await client.query('UPDATE transaction_example.invoices SET amount = 5000')
        await record(client)
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    expect((await pool.query('SELECT amount FROM transaction_example.invoices')).rows).toEqual([
      { amount: 4200 },
    ])
    expect(await recipients('a', first.eventId)).toEqual([original])
  })

  it('isolates concurrent organizations with the same invoice ID and idempotency key', async () => {
    await invoice('a')
    await invoice('b')
    const a = await endpoint('a', 'a')
    const b = await endpoint('b', 'b')
    await route('a', a)
    await route('b', b)

    // Each operation owns a separate connection and a separate captured recipient list.
    const [first, second] = await Promise.all([
      transaction((client) => record(client, 'a')),
      transaction((client) => record(client, 'b')),
    ])
    expect(first.eventId).not.toBe(second.eventId)
    expect(first.deliveryCount).toBe(1)
    expect(second.deliveryCount).toBe(1)
    expect(await recipients('a', first.eventId)).toEqual([a])
    expect(await recipients('b', second.eventId)).toEqual([b])
    expect(await recipients('a', second.eventId)).toEqual([])
    expect(await recipients('b', first.eventId)).toEqual([])
    expect((await delivery.deliveries.list()).items).toEqual([])
    await expect(
      delivery.forScope({ type: 'user', id: 'a' }).deliveries.list(),
    ).resolves.toMatchObject({ items: [] })
  })

  it('commits a valid zero-recipient event when the payload matches no route', async () => {
    await invoice()
    await route('a', await endpoint('a', 'usd'), { currency: 'USD' })
    const publication = await transaction((client) => record(client))
    expect(publication).toMatchObject({ deliveryCount: 0, duplicate: false })
    expect(await paid()).toBe(true)
    expect((await pool.query('SELECT id FROM public.webhook_events')).rows).toEqual([
      { id: publication.eventId },
    ])
    expect(await recipients('a', publication.eventId)).toEqual([])
  })
})
