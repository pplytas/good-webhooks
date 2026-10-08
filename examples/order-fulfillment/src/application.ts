import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { z } from 'zod'
import type { Runtime } from './runtime.ts'
import { orderInput, products } from './events.ts'
import { sealSecret } from './secrets.ts'
import { errorHandler, HttpError, localAdmin } from './http.ts'

const orderColumns =
  'id, customer, sku, quantity, total_cents AS "totalCents", event_id AS "eventId", created_at AS "createdAt"'
const endpointDescription = 'Northstar Supply warehouse'

export async function receiverState(runtime: Runtime) {
  const result = await runtime.pool.query(`SELECT mode, duplicate_count AS duplicates,
    (SELECT count(*)::integer FROM ${runtime.table('warehouse_shipments')}) AS accepted
    FROM ${runtime.table('warehouse_config')} WHERE singleton`)
  return result.rows[0]
}

export function createApplication(runtime: Runtime) {
  const { pool, webhooks, config, table } = runtime
  const app = express()
  app.disable('x-powered-by')
  app.use(localAdmin(config.appPort))
  app.use(express.json({ limit: '32kb' }))

  async function configuredEndpointId() {
    const result = await pool.query(
      `SELECT endpoint_id FROM ${table('warehouse_config')} WHERE singleton`,
    )
    return result.rows[0]?.endpoint_id as string | null
  }
  app.get('/api/state', async (_request, response) => {
    const endpointId = await configuredEndpointId()
    const [orders, endpoint, deliveries, shipments, receiver, heartbeat] = await Promise.all([
      pool.query(
        `SELECT ${orderColumns} FROM ${table('shop_orders')} ORDER BY created_at DESC, id DESC LIMIT 50`,
      ),
      endpointId ? webhooks.endpoints.get(endpointId) : null,
      webhooks.deliveries.list({ limit: 50 }),
      pool.query(
        `SELECT event_id AS "eventId", order_id AS "orderId", customer, received_at AS "receivedAt" FROM ${table('warehouse_shipments')} ORDER BY received_at DESC LIMIT 50`,
      ),
      receiverState(runtime),
      pool.query(`SELECT process_id AS "processId", last_seen_at AS "lastSeenAt", stopped_at AS "stoppedAt",
        stopped_at IS NULL AND last_seen_at > now() - interval '6 seconds' AS running
        FROM ${table('worker_heartbeat')} WHERE singleton`),
    ])
    response.json({
      products,
      orders: orders.rows,
      endpoint,
      deliveries: deliveries.items,
      shipments: shipments.rows,
      receiver,
      worker: heartbeat.rows[0] ?? { running: false },
    })
  })

  app.post('/api/connect', async (_request, response) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `northstar-connect:${config.schema}`,
      ])
      const current = await client.query(
        `SELECT endpoint_id FROM ${table('warehouse_config')} WHERE singleton FOR UPDATE`,
      )
      if (current.rows[0].endpoint_id) {
        const endpoint = await webhooks.endpoints.get(current.rows[0].endpoint_id)
        await client.query('COMMIT')
        response.json({ endpoint })
        return
      }
      // Endpoint management has its own transaction. Recover an interrupted first
      // connection through the public API before saving the one-time secret locally.
      const orphan = (await webhooks.endpoints.list()).find(
        (endpoint) =>
          endpoint.url === config.warehouseUrl &&
          endpoint.description === endpointDescription &&
          endpoint.status !== 'deleted',
      )
      const created = orphan
        ? await webhooks.endpoints.rotateSecret(orphan.id, { graceMs: 0 })
        : await webhooks.endpoints.create({
            url: config.warehouseUrl,
            description: endpointDescription,
            eventTypes: ['order.placed'],
          })
      await client.query(
        `UPDATE ${table('warehouse_config')} SET endpoint_id = $1, secret_ciphertext = $2 WHERE singleton`,
        [created.endpoint.id, sealSecret(created.secret, config.encryptionKey)],
      )
      await client.query('COMMIT')
      response.json({ endpoint: created.endpoint })
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  app.post('/api/orders', async (request, response) => {
    const input = orderInput.parse(request.body)
    const { customer, sku, quantity, idempotencyKey, rollback } = input
    const fingerprint = JSON.stringify({ customer, sku, quantity })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `northstar-order:${config.schema}:${idempotencyKey}`,
      ])
      const previous = await client.query(
        `SELECT ${orderColumns}, request_fingerprint, delivery_count FROM ${table('shop_orders')} WHERE idempotency_key = $1`,
        [idempotencyKey],
      )
      if (previous.rows[0]) {
        const { request_fingerprint, delivery_count, ...order } = previous.rows[0]
        if (request_fingerprint !== fingerprint)
          throw new HttpError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This idempotency key belongs to a different order.',
          )
        if (rollback)
          throw new HttpError(
            409,
            'ROLLBACK_REQUEST_REUSED',
            'Use a new request key for the rollback demonstration.',
          )
        await client.query('COMMIT')
        response.status(201).json({
          order,
          publication: { eventId: order.eventId, deliveryCount: delivery_count, duplicate: true },
        })
        return
      }
      const id = randomUUID()
      const totalCents = products.find((product) => product.sku === sku)!.unitPriceCents * quantity
      // Business writes and publication share this exact checked-out transaction.
      const publication = await webhooks.publish(
        {
          type: 'order.placed',
          data: { orderId: id, customer, sku, quantity, totalCents },
          idempotencyKey: `order:${idempotencyKey}`,
        },
        { transaction: client },
      )
      const saved = await client.query(
        `INSERT INTO ${table('shop_orders')} (id, customer, sku, quantity, total_cents, idempotency_key, request_fingerprint, event_id, delivery_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${orderColumns}`,
        [
          id,
          customer,
          sku,
          quantity,
          totalCents,
          idempotencyKey,
          fingerprint,
          publication.eventId,
          publication.deliveryCount,
        ],
      )
      if (rollback)
        throw new HttpError(
          409,
          'DEMO_ROLLBACK',
          'Rolled back the order and webhook publication together. Nothing was queued.',
        )
      await client.query('COMMIT')
      response.status(201).json({ order: saved.rows[0], publication })
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })
  app.get('/api/deliveries/:id', async (request, response) => {
    response.json(await webhooks.deliveries.get(request.params.id))
  })
  app.post('/api/deliveries/:id/replay', async (request, response) => {
    response.status(201).json(await webhooks.deliveries.replay(request.params.id))
  })
  app.post('/api/receiver', async (request, response) => {
    const { mode } = z
      .object({ mode: z.enum(['healthy', 'reject']) })
      .strict()
      .parse(request.body)
    await pool.query(`UPDATE ${table('warehouse_config')} SET mode = $1 WHERE singleton`, [mode])
    response.json(await receiverState(runtime))
  })
  app.post('/api/endpoint', async (request, response) => {
    const { status } = z
      .object({ status: z.enum(['active', 'paused']) })
      .strict()
      .parse(request.body)
    const id = await configuredEndpointId()
    if (!id) throw new HttpError(409, 'NOT_CONNECTED', 'Connect the warehouse first.')
    const endpoint = await (status === 'paused'
      ? webhooks.endpoints.pause(id)
      : webhooks.endpoints.resume(id))
    response.json({ endpoint })
  })
  app.use('/api', (_request, _response, next) =>
    next(new HttpError(404, 'NOT_FOUND', 'API route not found.')),
  )
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))))
  app.use(errorHandler)
  return app
}
