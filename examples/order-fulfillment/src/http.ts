import type { ErrorRequestHandler, RequestHandler } from 'express'
import { WebhookError } from 'good-webhooks'
import { ZodError } from 'zod'
import type { Server } from 'node:http'

export class HttpError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}
export function localAdmin(port: number): RequestHandler {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  const origins = new Set([...hosts].map((host) => `http://${host}`))
  return (request, response, next) => {
    if (!hosts.has(request.get('host') ?? ''))
      return next(new HttpError(403, 'FORBIDDEN_HOST', 'Use the local dashboard address.'))
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const origin = request.get('origin')
      if ((origin && !origins.has(origin)) || request.get('sec-fetch-site') === 'cross-site')
        return next(
          new HttpError(403, 'FORBIDDEN_ORIGIN', 'Only the local dashboard may change this demo.'),
        )
      if (!request.is('application/json'))
        return next(new HttpError(415, 'JSON_REQUIRED', 'Send application/json.'))
    }
    response.set('Cache-Control', 'no-store')
    next()
  }
}
export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof HttpError) {
    response.status(error.status).json({ error: error.message, code: error.code })
    return
  }
  if (error instanceof ZodError) {
    response.status(400).json({
      error: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      code: 'INVALID_INPUT',
    })
    return
  }
  if (error instanceof WebhookError) {
    const status =
      error.code === 'NOT_FOUND'
        ? 404
        : ['INVALID_STATE', 'REPLAY_IN_PROGRESS', 'IDEMPOTENCY_CONFLICT'].includes(error.code)
          ? 409
          : 400
    response.status(status).json({ error: error.message, code: error.code })
    return
  }
  if (error?.type === 'entity.too.large') {
    response.status(413).json({ error: 'Request body is too large.', code: 'INVALID_INPUT' })
    return
  }
  if (error?.type === 'entity.parse.failed') {
    response.status(400).json({ error: 'Invalid JSON.', code: 'INVALID_INPUT' })
    return
  }
  console.error('Request failed:', error instanceof Error ? error.message : 'unknown error')
  response
    .status(500)
    .json({ error: 'The request failed. Check the process log.', code: 'INTERNAL_ERROR' })
}
export function closeServer(server: Server) {
  return new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
}
export function installShutdown(cleanup: () => Promise<void>) {
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    const deadline = setTimeout(() => {
      console.error('Shutdown deadline exceeded.')
      process.exit(1)
    }, 20000)
    deadline.unref()
    cleanup()
      .catch((error) => {
        console.error('Shutdown failed:', error.message)
        process.exitCode = 1
      })
      .finally(() => clearTimeout(deadline))
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}
