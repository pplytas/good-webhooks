import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { createWebhooks, generateEncryptionKey } from '@pplytas/webhooks'
import { parseWebhook, type ParsedWebhook } from '@pplytas/webhooks/verify'
import { Pool } from 'pg'
import { events } from './events.ts'
import { readBody, respondToRequestError, respondToProcessingError } from './receiver.ts'

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    process.env.TEST_DATABASE_URL ??
    'postgres://postgres:webhooks_dev_only@127.0.0.1:55439/webhooks',
})

const webhooks = createWebhooks({
  database: pool,
  encryptionKey: process.env.WEBHOOK_ENCRYPTION_KEY ?? generateEncryptionKey(),
  events,
  allowLocalhost: true,
  retry: { delaysMs: [100, 250] },
})

// A unique business ID lets the example run again while preserving earlier history.
const invoiceId = `inv_${randomUUID()}`
const receivedIds: string[] = []
let signingSecret = ''
let endpointId: string | undefined

async function receive(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let event: ParsedWebhook<typeof events>
  try {
    event = await parseWebhook({
      body: await readBody(request),
      secret: signingSecret,
      headers: request.headers,
      events,
    })
  } catch (error) {
    respondToRequestError(error, response)
    return
  }
  assert.equal(event.data.invoiceId, invoiceId)
  assert.equal(event.data.amount, 4200)
  receivedIds.push(event.id)
  if (receivedIds.length === 1) {
    response.writeHead(503).end('Try again')
    return
  }
  // This demo's application tables are installed through receiver.sql, not by the library.
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const receipt = await client.query(
      'INSERT INTO webhooks_example.receipts (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id',
      [event.id],
    )
    if (receipt.rowCount) {
      await client.query('INSERT INTO webhooks_example.invoices (id,amount) VALUES ($1,$2)', [
        event.data.invoiceId,
        event.data.amount,
      ])
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  response.writeHead(200).end('Accepted')
}

const receiver = createServer((request, response) => {
  void receive(request, response).catch((error) => {
    respondToProcessingError(error, response)
  })
})

async function finishDelivery(id: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const detail = await webhooks.deliveries.get(id)
    if (detail.status === 'succeeded') return
    assert(!['failed', 'cancelled'].includes(detail.status), `Delivery ended as ${detail.status}`)
    await sleep(Math.max(10, Math.min(500, detail.nextAttemptAt.getTime() - Date.now())))
    await webhooks.worker.tick()
  }
  throw new Error('The demo delivery did not finish within 10 seconds.')
}

try {
  await webhooks.check()
  receiver.listen(0, '127.0.0.1')
  await once(receiver, 'listening')
  const address = receiver.address()
  assert(address && typeof address === 'object')
  const created = await webhooks.endpoints.create({
    url: `http://127.0.0.1:${address.port}/webhooks`,
    eventTypes: ['invoice.paid'],
  })
  endpointId = created.endpoint.id
  signingSecret = created.secret

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await webhooks.publish(
      {
        type: 'invoice.paid',
        data: { invoiceId: 'rolled_back', amount: 100 },
        idempotencyKey: 'rolled-back-publication',
      },
      { transaction: client },
    )
    await client.query('ROLLBACK')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  assert.equal((await webhooks.deliveries.list({ endpointId })).items.length, 0)
  console.log('Transaction rollback left no delivery.')

  const input = {
    type: 'invoice.paid' as const,
    data: { invoiceId, amount: 4200 },
    idempotencyKey: `invoice-paid:${invoiceId}`,
  }
  const publication = await webhooks.publish(input)
  const duplicate = await webhooks.publish(input)
  assert.equal(publication.deliveryCount, 1)
  assert.equal(duplicate.eventId, publication.eventId)
  assert.equal(duplicate.duplicate, true)
  console.log('Event accepted:', publication.eventId)

  const [delivery] = (await webhooks.deliveries.list({ eventId: publication.eventId })).items
  assert(delivery)
  await webhooks.worker.tick()
  const afterFailure = await webhooks.deliveries.get(delivery.id)
  assert.equal(afterFailure.status, 'pending')
  assert.equal(afterFailure.attempts[0]?.responseStatus, 503)
  await finishDelivery(delivery.id)
  const delivered = await webhooks.deliveries.get(delivery.id)
  assert.deepEqual(
    delivered.attempts.map((attempt) => attempt.responseStatus),
    [503, 200],
  )
  console.log(`Delivery ${delivered.id} succeeded after ${delivered.attemptCount} attempts.`)
  console.table(
    delivered.attempts.map(({ number, outcome, responseStatus }) => ({
      number,
      outcome,
      responseStatus,
    })),
  )

  const replay = await webhooks.deliveries.replay(delivery.id)
  assert.notEqual(replay.id, delivery.id)
  assert.equal(replay.eventId, publication.eventId)
  await finishDelivery(replay.id)
  assert.deepEqual(receivedIds, [publication.eventId, publication.eventId, publication.eventId])
  assert.equal(
    (
      await pool.query('SELECT event_id FROM webhooks_example.receipts WHERE event_id=$1', [
        publication.eventId,
      ])
    ).rowCount,
    1,
  )
  assert.deepEqual(
    (await pool.query('SELECT amount FROM webhooks_example.invoices WHERE id=$1', [invoiceId]))
      .rows,
    [{ amount: 4200 }],
  )
  console.log(
    `Replay ${replay.id} succeeded with the same event ID. Receiver applied the event once.`,
  )
} finally {
  // Keep history, but leave no active endpoint pointing at the stopped receiver.
  if (endpointId)
    await webhooks.endpoints
      .remove(endpointId)
      .catch((error) => console.error('Endpoint cleanup failed:', error))
  if (receiver.listening)
    await new Promise<void>((resolve, reject) =>
      receiver.close((error) => (error ? reject(error) : resolve())),
    )
  await pool.end()
}
