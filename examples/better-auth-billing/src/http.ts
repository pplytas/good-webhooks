import type { Server } from 'node:http'
import type { ErrorRequestHandler, RequestHandler } from 'express'
import { ZodError } from 'zod'
import { WebhookError } from 'good-webhooks/verify'
import { HttpError } from './billing.ts'

export function hostGuard(origin: string): RequestHandler {
  return (req, res, next) => {
    if (req.headers.host !== new URL(origin).host) {
      res.status(403).json({ error: 'Use the configured 127.0.0.1 address' })
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    next()
  }
}
export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({ error: error.issues.map((i) => i.message).join('; ') })
    return
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message })
    return
  }
  if (error instanceof WebhookError) {
    const status =
      error.code === 'NOT_FOUND'
        ? 404
        : ['INVALID_STATE', 'REPLAY_IN_PROGRESS', 'IDEMPOTENCY_CONFLICT'].includes(error.code)
          ? 409
          : error.code === 'INVALID_INPUT'
            ? 400
            : 500
    res.status(status).json({
      error: status === 500 ? 'Webhook operation failed. Check the server log.' : error.message,
    })
    return
  }
  if (error?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body is too large' })
    return
  }
  if (error instanceof SyntaxError) {
    res.status(400).json({ error: 'Invalid JSON' })
    return
  }
  console.error('Request failed:', error)
  res.status(500).json({ error: 'Request failed. Check the server log.' })
}
export function installShutdown(server: Server, close: () => Promise<void>) {
  let stopping = false
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      if (stopping) return
      stopping = true
      const deadline = setTimeout(() => process.exit(1), 15_000).unref()
      server.close(async () => {
        try {
          await close()
          clearTimeout(deadline)
        } catch (error) {
          console.error(error)
          process.exitCode = 1
        }
      })
    })
}
