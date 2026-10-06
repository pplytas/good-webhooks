import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { generateSecret, signWebhook } from '../src/crypto.js'
import { parseWebhook, WebhookError } from 'webhook-dispatch/verify'
import type { EventDefinitions } from '../src/types.js'
import {
  readBody,
  respondToRequestError,
  respondToProcessingError,
} from '../examples/basic/receiver.ts'
import { asyncZod } from '../examples/basic/async-zod.ts'
import { events } from '../examples/basic/events.ts'

const secret = generateSecret()
const envelope = {
  id: 'event_1',
  type: 'invoice.paid',
  occurredAt: new Date().toISOString(),
  data: { invoiceId: 'inv_1', amount: 4200 },
}
const body = JSON.stringify(envelope)
const headers = signWebhook({
  body,
  id: envelope.id,
  timestamp: Math.floor(Date.now() / 1000),
  secrets: [secret],
})
afterEach(() => vi.restoreAllMocks())

async function withReceiver(
  definitions: EventDefinitions,
  run: (url: string) => Promise<void>,
  configuredSecret = secret,
  apply: () => Promise<void> = async () => {},
) {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        await parseWebhook({
          body: await readBody(request),
          headers: request.headers,
          secret: configuredSecret,
          events: definitions,
        })
      } catch (error) {
        respondToRequestError(error, response)
        return
      }
      await apply()
      response.writeHead(204).end()
    })().catch((error) => respondToProcessingError(error, response))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No receiver address')
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

describe('HTTP receiver example', () => {
  it('accepts a valid signed event only after business work completes', async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    await withReceiver(
      events,
      async (url) => {
        let acknowledged = false
        const pending = fetch(url, { method: 'POST', body, headers }).then((response) => {
          acknowledged = true
          return response
        })
        await started
        expect(acknowledged).toBe(false)
        release()
        expect((await pending).status).toBe(204)
      },
      secret,
      async () => {
        entered()
        await gate
      },
    )
  })

  it('returns 400 for bad signatures and payloads', async () => {
    await withReceiver(events, async (url) => {
      expect((await fetch(url, { method: 'POST', body: body + ' ', headers })).status).toBe(400)
      const invalidBody = JSON.stringify({ ...envelope, data: false })
      const invalidHeaders = signWebhook({
        body: invalidBody,
        id: envelope.id,
        timestamp: Math.floor(Date.now() / 1000),
        secrets: [secret],
      })
      expect(
        (await fetch(url, { method: 'POST', body: invalidBody, headers: invalidHeaders })).status,
      ).toBe(400)
    })
  })

  it('rejects oversized uploads with known length and while streaming', async () => {
    const validate = vi.fn((value: unknown) => ({ value }))
    await withReceiver(
      { 'invoice.paid': { '~standard': { version: 1, vendor: 'test', validate } } },
      async (url) => {
        for (const knownLength of [true, false]) {
          const status = await new Promise<number | undefined>((resolve, reject) => {
            const upload = httpRequest(
              url,
              {
                method: 'POST',
                headers: {
                  ...headers,
                  ...(knownLength ? { 'content-length': '524289' } : {}),
                },
              },
              (response) => {
                resolve(response.statusCode)
                response.resume()
                upload.destroy()
              },
            )
            upload.on('error', reject)
            // Keep the upload open. The receiver must reject before waiting for its end.
            upload.write(knownLength ? 'x' : Buffer.alloc(524289))
          })
          expect(status).toBe(413)
        }
      },
    )
    expect(validate).not.toHaveBeenCalled()
  })

  it('keeps trusted configuration and business failures retryable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await withReceiver(
      events,
      async (url) => {
        expect((await fetch(url, { method: 'POST', body, headers })).status).toBe(500)
      },
      'invalid-secret',
    )
    await withReceiver(
      events,
      async (url) => {
        expect((await fetch(url, { method: 'POST', body, headers })).status).toBe(500)
      },
      secret,
      async () => {
        throw new Error('Database unavailable')
      },
    )
  })

  it('uses public safeParseAsync to contain Zod async failures and run callbacks once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const transform = vi.fn(async () => {
      throw new WebhookError('PAYLOAD_INVALID', 'application decoder failure')
    })
    await withReceiver(
      { 'invoice.paid': asyncZod(events['invoice.paid'].transform(transform)) },
      async (url) => {
        expect((await fetch(url, { method: 'POST', body, headers })).status).toBe(500)
      },
    )
    expect(transform).toHaveBeenCalledTimes(1)
    const schema = asyncZod(z.string().transform(async (value) => value.length))
    await expect(schema['~standard'].validate('abc')).resolves.toEqual({ value: 3 })
    await expect(schema['~standard'].validate(123)).resolves.toHaveProperty('issues')
  })

  it.each(['PAYLOAD_INVALID', 'SIGNATURE_INVALID', 'SIGNATURE_EXPIRED'] as const)(
    'returns 500 when business work throws %s',
    async (code) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await withReceiver(
        events,
        async (url) => {
          expect((await fetch(url, { method: 'POST', body, headers })).status).toBe(500)
        },
        secret,
        async () => {
          throw new WebhookError(code, 'Business failure')
        },
      )
    },
  )
})
