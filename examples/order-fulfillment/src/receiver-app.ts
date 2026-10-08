import express from 'express'
import { parseWebhook, WebhookError } from 'good-webhooks/verify'
import { events } from './events.ts'
import type { Runtime } from './runtime.ts'
import { openSecret } from './secrets.ts'
import { errorHandler, HttpError } from './http.ts'

export function createReceiver(runtime: Runtime) {
  const { pool, table, config } = runtime
  const app = express()
  app.disable('x-powered-by')
  app.get('/health', (_request, response) => response.json({ ready: true }))
  app.post('/webhooks', express.raw({ type: '*/*', limit: '512kb' }), async (request, response) => {
    const settings = await pool.query(
      `SELECT secret_ciphertext, mode FROM ${table('warehouse_config')} WHERE singleton`,
    )
    const setting = settings.rows[0]
    if (!setting.secret_ciphertext)
      throw new HttpError(503, 'NOT_CONNECTED', 'Warehouse is not connected.')
    let event
    try {
      event = await parseWebhook({
        body: request.body ?? Buffer.alloc(0),
        headers: request.headers,
        secret: openSecret(setting.secret_ciphertext, config.encryptionKey),
        events,
      })
    } catch (error) {
      if (error instanceof WebhookError) throw new HttpError(400, error.code, error.message)
      throw error
    }
    if (setting.mode === 'reject')
      throw new HttpError(503, 'WAREHOUSE_UNAVAILABLE', 'Warehouse is temporarily unavailable.')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const receipt = await client.query(
        `INSERT INTO ${table('warehouse_receipts')} (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id`,
        [event.id],
      )
      if (receipt.rowCount === 0) {
        await client.query(
          `UPDATE ${table('warehouse_config')} SET duplicate_count = duplicate_count + 1 WHERE singleton`,
        )
        await client.query('COMMIT')
        response.json({ accepted: true, duplicate: true, eventId: event.id })
        return
      }
      await client.query(
        `INSERT INTO ${table('warehouse_shipments')} (event_id, order_id, customer) VALUES ($1,$2,$3)`,
        [event.id, event.data.orderId, event.data.customer],
      )
      await client.query('COMMIT')
      response.json({ accepted: true, duplicate: false, eventId: event.id })
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })
  app.use(errorHandler)
  return app
}
