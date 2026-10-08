import express from 'express'
import { parseWebhook } from 'good-webhooks/verify'
import type { Pool } from 'pg'
import { config } from './config.ts'
import { events } from './events.ts'
import { decryptSecret } from './secrets.ts'
import { transaction } from './database.ts'
import { hostGuard, errorHandler } from './http.ts'

export function createReceiver(pool: Pool) {
  const app = express()
  app.disable('x-powered-by')
  app.use(hostGuard(config.receiverOrigin))
  app.get('/health', (_req, res) => res.json({ ok: true }))
  // The verifier receives the bytes the sender signed, before JSON parsing.
  app.post('/webhooks/:routeId', express.raw({ type: '*/*', limit: '512kb' }), async (req, res) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.routeId)) {
      res.sendStatus(404)
      return
    }
    const result = await pool.query('SELECT * FROM billing_receivers WHERE route_id = $1', [
      req.params.routeId,
    ])
    if (!result.rowCount) {
      res.status(404).send('Transfer this endpoint’s signing secret first')
      return
    }
    const receiver = result.rows[0]
    // Configuration/decryption failures are server errors, never signature failures.
    const secret = decryptSecret(receiver.encrypted_secret)
    let event
    try {
      event = await parseWebhook({ body: req.body, headers: req.headers, secret, events })
    } catch {
      await pool.query(
        "INSERT INTO billing_receiver_requests (endpoint_id, outcome) VALUES ($1,'invalid')",
        [receiver.endpoint_id],
      )
      res.status(400).send('Invalid webhook signature or envelope')
      return
    }
    if (receiver.mode === 'reject') {
      await pool.query(
        "INSERT INTO billing_receiver_requests (endpoint_id, event_id, outcome) VALUES ($1,$2,'rejected')",
        [receiver.endpoint_id, event.id],
      )
      res.status(503).send('Receiver is intentionally rejecting deliveries')
      return
    }
    const duplicate = await transaction(pool, async (client) => {
      const inserted = await client.query(
        `INSERT INTO billing_receipts (endpoint_id, event_id, event_type, invoice_id, payload)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (endpoint_id,event_id) DO NOTHING RETURNING event_id`,
        [
          receiver.endpoint_id,
          event.id,
          event.type,
          event.data.invoiceId,
          JSON.stringify(event.data),
        ],
      )
      if (inserted.rowCount) {
        // An invoice.created retry may arrive after invoice.paid. Never regress paid state.
        await client.query(
          `INSERT INTO billing_receiver_invoices (endpoint_id, invoice_id, customer, total, currency, status)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (endpoint_id,invoice_id) DO UPDATE SET
          status = CASE WHEN billing_receiver_invoices.status = 'paid' THEN 'paid' ELSE EXCLUDED.status END,
          updated_at = now()`,
          [
            receiver.endpoint_id,
            event.data.invoiceId,
            event.data.customer,
            event.data.total,
            event.data.currency,
            event.type === 'invoice.paid' ? 'paid' : 'open',
          ],
        )
      }
      const duplicate = !inserted.rowCount
      await client.query(
        'INSERT INTO billing_receiver_requests (endpoint_id,event_id,outcome) VALUES ($1,$2,$3)',
        [receiver.endpoint_id, event.id, duplicate ? 'duplicate' : 'accepted'],
      )
      return duplicate
    })
    res.json({ accepted: true, duplicate })
  })
  app.use(errorHandler)
  return app
}
