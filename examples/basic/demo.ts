import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { createWebhooks, generateEncryptionKey } from '@pplytas/webhooks'
import { verifyWebhook } from '@pplytas/webhooks/verify'
import { Pool } from 'pg'
import { z } from 'zod'

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    process.env.TEST_DATABASE_URL ??
    'postgres://postgres:webhooks_dev_only@127.0.0.1:55439/webhooks',
})

const webhooks = createWebhooks({
  database: pool,
  encryptionKey: process.env.WEBHOOK_ENCRYPTION_KEY ?? generateEncryptionKey(),
  events: {
    'invoice.paid': z.object({ invoiceId: z.string(), amount: z.number().int().nonnegative() }),
  },
  allowLocalhost: true,
  retry: { delaysMs: [100, 250] },
})

// A real application derives this scope from an authenticated, authorized caller.
const tenant = webhooks.forTenant({ id: `demo_${randomUUID()}` })
const receivedIds: string[] = []
const appliedIds = new Set<string>()
let appliedCount = 0
let signingSecret = ''
let endpointId: string | undefined

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  assert(!Array.isArray(value), `Duplicate ${name} header`)
  return value
}

async function receive(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const body = Buffer.concat(chunks)
  verifyWebhook({
    body,
    secret: signingSecret,
    headers: {
      'webhook-id': header(request, 'webhook-id'),
      'webhook-timestamp': header(request, 'webhook-timestamp'),
      'webhook-signature': header(request, 'webhook-signature'),
    },
  })
  const event: { id: string; type: string; data: { invoiceId: string; amount: number } } =
    JSON.parse(body.toString('utf8'))
  assert.equal(event.id, header(request, 'webhook-id'))
  assert.equal(event.type, 'invoice.paid')
  receivedIds.push(event.id)
  if (receivedIds.length === 1) {
    response.writeHead(503).end('Try again')
    return
  }
  // Production receivers use durable deduplication in the same transaction as their work.
  if (!appliedIds.has(event.id)) {
    appliedCount += 1
    appliedIds.add(event.id)
  }
  response.writeHead(200).end('Accepted')
}

const receiver = createServer((request, response) => {
  void receive(request, response).catch((error) => {
    console.error('Receiver rejected the request:', error)
    response.writeHead(400).end('Invalid webhook')
  })
})

async function finishDelivery(id: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const detail = await tenant.deliveries.get(id)
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
  const created = await tenant.endpoints.create({
    url: `http://127.0.0.1:${address.port}/webhooks`,
    eventTypes: ['invoice.paid'],
  })
  endpointId = created.endpoint.id
  signingSecret = created.secret

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await tenant.publish(
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
  assert.equal((await tenant.deliveries.list()).items.length, 0)
  console.log('Transaction rollback left no delivery.')

  const input = {
    type: 'invoice.paid' as const,
    data: { invoiceId: 'inv_demo', amount: 4200 },
    idempotencyKey: 'invoice-paid:inv_demo',
  }
  const publication = await tenant.publish(input)
  const duplicate = await tenant.publish(input)
  assert.equal(publication.deliveryCount, 1)
  assert.equal(duplicate.eventId, publication.eventId)
  assert.equal(duplicate.duplicate, true)
  console.log('Event accepted:', publication.eventId)

  const [delivery] = (await tenant.deliveries.list()).items
  assert(delivery)
  await webhooks.worker.tick()
  const afterFailure = await tenant.deliveries.get(delivery.id)
  assert.equal(afterFailure.status, 'pending')
  assert.equal(afterFailure.attempts[0]?.responseStatus, 503)
  await finishDelivery(delivery.id)
  const delivered = await tenant.deliveries.get(delivery.id)
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

  const replay = await tenant.deliveries.replay(delivery.id)
  assert.notEqual(replay.id, delivery.id)
  assert.equal(replay.eventId, publication.eventId)
  await finishDelivery(replay.id)
  assert.deepEqual(receivedIds, [publication.eventId, publication.eventId, publication.eventId])
  assert.equal(appliedIds.size, 1)
  assert.equal(appliedCount, 1)
  console.log(
    `Replay ${replay.id} succeeded with the same event ID. Receiver applied the event once.`,
  )
} finally {
  // Keep history, but leave no active endpoint pointing at the stopped receiver.
  if (endpointId)
    await tenant.endpoints
      .remove(endpointId)
      .catch((error) => console.error('Endpoint cleanup failed:', error))
  if (receiver.listening)
    await new Promise<void>((resolve, reject) =>
      receiver.close((error) => (error ? reject(error) : resolve())),
    )
  await pool.end()
}
