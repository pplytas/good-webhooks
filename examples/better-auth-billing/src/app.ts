import express from 'express'
import { fileURLToPath } from 'node:url'
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node'
import { z } from 'zod'
import { config } from './config.ts'
import type { Context } from './context.ts'
import { transaction } from './database.ts'
import { createInvoice, payInvoice, invoiceInput, HttpError } from './billing.ts'
import { encryptSecret } from './secrets.ts'
import { hostGuard, errorHandler } from './http.ts'

export function createApp({ pool, auth, delivery, management }: Context) {
  const app = express()
  app.disable('x-powered-by')
  app.use(hostGuard(config.appOrigin))
  app.use((req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    )
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.headers.origin !== config.appOrigin
    ) {
      res.status(403).json({ error: 'A same-origin request is required' })
      return
    }
    next()
  })
  // Better Auth owns its body parsing. Mount before express.json().
  app.all('/api/auth/{*path}', toNodeHandler(auth))
  app.use(express.json({ limit: '64kb' }))
  app.get('/health', (_req, res) => res.json({ ok: true }))
  app.use('/api', async (req, res, next) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
    if (!session) {
      res.status(401).json({ error: 'Sign in first' })
      return
    }
    res.locals.userId = session.user.id
    next()
  })
  app.get('/api/workspace', async (_req, res) => {
    const owner = res.locals.userId as string
    const [invoices, receivers, outcomes, requests, deliveries] = await Promise.all([
      pool.query(
        'SELECT * FROM billing_invoices WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 100',
        [owner],
      ),
      pool.query(
        'SELECT endpoint_id, route_id, mode, connected_at FROM billing_receivers WHERE owner_id = $1',
        [owner],
      ),
      pool.query(
        'SELECT r.* FROM billing_receiver_invoices r JOIN billing_receivers e USING (endpoint_id) WHERE e.owner_id = $1 ORDER BY updated_at DESC LIMIT 50',
        [owner],
      ),
      pool.query(
        'SELECT r.* FROM billing_receiver_requests r JOIN billing_receivers e USING (endpoint_id) WHERE e.owner_id = $1 ORDER BY id DESC LIMIT 50',
        [owner],
      ),
      delivery.forScope({ type: 'user', id: owner }).deliveries.list({ limit: 50 }),
    ])
    res.json({
      receiverOrigin: config.receiverOrigin,
      invoices: invoices.rows,
      receivers: receivers.rows,
      outcomes: outcomes.rows,
      requests: requests.rows,
      deliveries,
    })
  })
  app.post('/api/invoices', async (req, res) => {
    const input = invoiceInput.parse(req.body)
    res
      .status(201)
      .json(
        await transaction(pool, (client) =>
          createInvoice(client, delivery, res.locals.userId, input),
        ),
      )
  })
  app.post('/api/invoices/:id/pay', async (req, res) => {
    z.object({}).strict().parse(req.body)
    const id = z.uuid().parse(req.params.id)
    res.json(
      await transaction(pool, (client) => payInvoice(client, delivery, res.locals.userId, id)),
    )
  })
  app.get('/api/deliveries/:id', async (req, res) => {
    const id = z.string().regex(/^\d+$/).parse(req.params.id)
    res.json(await delivery.forScope({ type: 'user', id: res.locals.userId }).deliveries.get(id))
  })
  app.post('/api/deliveries/:id/replay', async (req, res) => {
    z.object({}).strict().parse(req.body)
    const id = z.string().regex(/^\d+$/).parse(req.params.id)
    res.json(await delivery.forScope({ type: 'user', id: res.locals.userId }).deliveries.replay(id))
  })
  app.post('/api/receivers/connect', async (req, res) => {
    const body = z
      .object({ endpointId: z.string().min(1), secret: z.string().startsWith('whsec_') })
      .strict()
      .parse(req.body)
    const scope = { type: 'user', id: res.locals.userId as string }
    const endpoint = await management.get(scope, body.endpointId)
    const url = new URL(endpoint.url)
    if (
      url.origin !== config.receiverOrigin ||
      url.search ||
      url.hash ||
      !/^\/webhooks\/[0-9a-f-]{36}$/.test(url.pathname)
    )
      throw new HttpError(400, 'Use a URL on this example’s local receiver')
    const routeId = z.uuid().parse(url.pathname.split('/')[2])
    const resolution = await management.source.resolveEndpoint(scope, endpoint.id)
    if (resolution.status !== 'active' || !resolution.secrets.includes(body.secret))
      throw new HttpError(400, 'The secret must match an active endpoint')
    const existing = await pool.query(
      'SELECT endpoint_id FROM billing_receivers WHERE route_id = $1',
      [routeId],
    )
    if (existing.rowCount && existing.rows[0].endpoint_id !== endpoint.id)
      throw new HttpError(409, 'This receiver URL belongs to another endpoint')
    await pool.query(
      `INSERT INTO billing_receivers (endpoint_id, owner_id, route_id, encrypted_secret) VALUES ($1,$2,$3,$4)
      ON CONFLICT (endpoint_id) DO UPDATE SET encrypted_secret = EXCLUDED.encrypted_secret`,
      [endpoint.id, scope.id, routeId, encryptSecret(body.secret)],
    )
    res.json({ connected: true })
  })
  app.post('/api/receivers/:id/mode', async (req, res) => {
    const { mode } = z
      .object({ mode: z.enum(['healthy', 'reject']) })
      .strict()
      .parse(req.body)
    const result = await pool.query(
      'UPDATE billing_receivers SET mode = $1 WHERE endpoint_id = $2 AND owner_id = $3 RETURNING endpoint_id',
      [mode, req.params.id, res.locals.userId],
    )
    if (!result.rowCount) throw new HttpError(404, 'Connected receiver not found')
    res.json({ mode })
  })
  app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url)), { etag: false }))
  app.use(errorHandler)
  return app
}
