import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import http, {
  type ClientRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import https from 'node:https'
import { PassThrough, Writable } from 'node:stream'
import type { DetailedPeerCertificate } from 'node:tls'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertSafeUrl, sendWebhook } from '../src/transport.js'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))

const lookupAll = vi.mocked(
  lookup as (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>,
)

const servers: Server[] = []
const defaultInput = {
  body: '{"message":"hello"}',
  headers: { 'webhook-id': 'msg_123' },
  timeoutMs: 1_000,
  maxResponseBytes: 1_024,
  allowLocalhost: true,
}

async function receiver(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No receiver address')
  return `http://127.0.0.1:${address.port}`
}

beforeEach(() => {
  lookupAll.mockReset()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
})

describe('URL and DNS validation', () => {
  it.each([
    'http://example.com',
    'ftp://example.com',
    'file:///etc/passwd',
    'https://user:pass@example.com',
    'https://@example.com',
    'https://example.com/#fragment',
    'https://example.com/#',
    'https://example.com\\@127.0.0.1',
    ' https://example.com',
    'https://exam\nple.com',
    'https://localhost',
    'https://localhost.',
    'https://127.0.0.1',
    'https://127.1',
    'https://2130706433',
    'https://0x7f000001',
    'https://0177.0.0.1',
    'https://0.0.0.0',
    'https://10.0.0.1',
    'https://172.16.0.1',
    'https://192.168.1.1',
    'https://169.254.169.254',
    'https://168.63.129.16',
    'https://100.64.0.1',
    'https://192.0.2.1',
    'https://198.51.100.1',
    'https://203.0.113.1',
    'https://198.18.0.1',
    'https://224.0.0.1',
    'https://240.0.0.1',
    'https://[::]',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
    'https://[::ffff:8.8.8.8]',
    'https://[fc00::1]',
    'https://[fe80::1]',
    'https://[ff02::1]',
    'https://[2001:db8::1]',
    'https://[64:ff9b::808:808]',
    'https://[2002:0808:0808::1]',
    'https://[3fff::1]',
  ])('rejects unsafe URL %s', async (url) => {
    await expect(assertSafeUrl(url, false)).rejects.toMatchObject({ code: 'UNSAFE_URL' })
  })

  it('accepts public IPv4 and IPv6 literals without DNS', async () => {
    await expect(assertSafeUrl('https://8.8.8.8/hook', false)).resolves.toBeUndefined()
    await expect(
      assertSafeUrl('https://[2606:4700:4700::1111]/hook', false),
    ).resolves.toBeUndefined()
    expect(lookup).not.toHaveBeenCalled()
  })

  it('rejects any unsafe answer in a mixed DNS result', async () => {
    lookupAll.mockResolvedValueOnce([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ])
    await expect(assertSafeUrl('https://receiver.example/hook', false)).rejects.toMatchObject({
      code: 'UNSAFE_URL',
    })
    expect(lookup).toHaveBeenCalledWith('receiver.example', { all: true, verbatim: true })
  })

  it('allows only literal loopback and localhost with the development option', async () => {
    await expect(assertSafeUrl('http://127.0.0.1:1234/hook', true)).resolves.toBeUndefined()
    await expect(assertSafeUrl('http://[::1]:1234/hook', true)).resolves.toBeUndefined()
    lookupAll.mockResolvedValueOnce([
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 },
    ])
    await expect(assertSafeUrl('http://localhost:1234/hook', true)).resolves.toBeUndefined()
    for (const url of [
      'http://8.8.8.8',
      'http://10.0.0.1',
      'https://10.0.0.1',
      'http://[::ffff:127.0.0.1]',
    ]) {
      await expect(assertSafeUrl(url, true)).rejects.toMatchObject({ code: 'UNSAFE_URL' })
    }
    lookupAll.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
    await expect(assertSafeUrl('https://attacker.example', true)).rejects.toMatchObject({
      code: 'UNSAFE_URL',
    })
  })

  it('does not trust localhost when DNS returns a non-loopback answer', async () => {
    lookupAll.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
    await expect(assertSafeUrl('http://localhost', true)).rejects.toMatchObject({
      code: 'UNSAFE_URL',
    })
  })

  it('re-resolves and rechecks DNS after registration', async () => {
    lookupAll.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
    await assertSafeUrl('https://receiver.example', false)
    lookupAll.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }])
    const request = vi.spyOn(https, 'request')
    const result = await sendWebhook({
      ...defaultInput,
      url: 'https://receiver.example',
      allowLocalhost: false,
    })
    expect(result).toEqual({ status: null, responseBody: '', error: 'unsafe_url' })
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(request).not.toHaveBeenCalled()
  })

  it('pins the vetted address and keeps the original Host and TLS identity', async () => {
    lookupAll.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
    let captured: https.RequestOptions | undefined
    const implementation = (
      options: https.RequestOptions,
      callback: (message: IncomingMessage) => void,
    ): ClientRequest => {
      captured = options
      const request = new Writable({
        write(_chunk, _encoding, done) {
          done()
        },
      })
      request.on('finish', () => {
        const response = new PassThrough() as unknown as IncomingMessage
        response.statusCode = 204
        callback(response)
        response.push(null)
      })
      return request as unknown as ClientRequest
    }
    vi.spyOn(https, 'request').mockImplementation(implementation as typeof https.request)
    const result = await sendWebhook({
      ...defaultInput,
      url: 'https://receiver.example:8443/webhook?q=1',
      allowLocalhost: false,
    })
    expect(result).toEqual({ status: 204, responseBody: '', error: null })
    expect(captured).toMatchObject({
      hostname: '8.8.8.8',
      family: 4,
      port: '8443',
      path: '/webhook?q=1',
      servername: 'receiver.example',
      rejectUnauthorized: true,
      agent: false,
      headers: { host: 'receiver.example:8443' },
    })
    expect(captured?.checkServerIdentity).toBeTypeOf('function')
    const matchingCertificate = {
      subjectaltname: 'DNS:receiver.example',
    } as DetailedPeerCertificate
    const wrongCertificate = { subjectaltname: 'IP Address:8.8.8.8' } as DetailedPeerCertificate
    expect(captured?.checkServerIdentity?.('8.8.8.8', matchingCertificate)).toBeUndefined()
    expect(captured?.checkServerIdentity?.('8.8.8.8', wrongCertificate)).toBeInstanceOf(Error)
    expect(lookup).toHaveBeenCalledTimes(1)
  })
})

describe('HTTP delivery', () => {
  it('posts exact UTF-8 bytes with a matching content length only when localhost is enabled', async () => {
    const seen: { body: string; method: string | undefined; headers: http.IncomingHttpHeaders }[] =
      []
    const url = await receiver((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        seen.push({
          body: Buffer.concat(chunks).toString('utf8'),
          method: request.method,
          headers: request.headers,
        })
        response.writeHead(202).end('accepted')
      })
    })
    const body = '{"message":"γειά 🌎"}'
    expect(await sendWebhook({ ...defaultInput, url, body, allowLocalhost: false })).toMatchObject({
      status: null,
      error: 'unsafe_url',
    })
    expect(seen).toHaveLength(0)
    expect(await sendWebhook({ ...defaultInput, url, body })).toEqual({
      status: 202,
      responseBody: 'accepted',
      error: null,
    })
    expect(seen).toEqual([
      {
        body,
        method: 'POST',
        headers: expect.objectContaining({
          'content-length': String(Buffer.byteLength(body)),
          'content-type': 'application/json',
          'webhook-id': 'msg_123',
        }),
      },
    ])
  })

  it('returns redirects without following them', async () => {
    const paths: string[] = []
    const url = await receiver((request, response) => {
      paths.push(request.url ?? '')
      response.writeHead(302, { location: '/second' }).end('redirect')
    })
    expect(await sendWebhook({ ...defaultInput, url: `${url}/first` })).toEqual({
      status: 302,
      responseBody: 'redirect',
      error: null,
    })
    expect(paths).toEqual(['/first'])
  })

  it('stops reading at the response byte limit without waiting for the response to finish', async () => {
    const url = await receiver((_request, response) => {
      response.writeHead(200)
      response.write(Buffer.alloc(100_000, 'a'))
    })
    const started = performance.now()
    expect(await sendWebhook({ ...defaultInput, url, maxResponseBytes: 64 })).toEqual({
      status: 200,
      responseBody: 'a'.repeat(64),
      error: null,
    })
    expect(performance.now() - started).toBeLessThan(700)
  })

  it('can disable response diagnostics', async () => {
    const url = await receiver((_request, response) => {
      response.writeHead(200)
      response.flushHeaders()
    })
    expect(await sendWebhook({ ...defaultInput, url, maxResponseBytes: 0 })).toEqual({
      status: 200,
      responseBody: '',
      error: null,
    })
  })

  it('keeps binary diagnostics valid for PostgreSQL text and within the UTF-8 byte limit', async () => {
    const url = await receiver((_request, response) =>
      response.writeHead(200).end(Buffer.from([0, 0xff, 0xe2, 0x82, 0xac])),
    )
    const result = await sendWebhook({ ...defaultInput, url, maxResponseBytes: 4 })
    expect(result.status).toBe(200)
    expect(result.error).toBeNull()
    expect(result.responseBody).not.toContain('\0')
    expect(Buffer.byteLength(result.responseBody)).toBeLessThanOrEqual(4)
  })

  it('truncates multibyte response text at character boundaries', async () => {
    const url = await receiver((_request, response) => response.writeHead(200).end('ééé'))
    expect(await sendWebhook({ ...defaultInput, url, maxResponseBytes: 5 })).toEqual({
      status: 200,
      responseBody: 'éé',
      error: null,
    })
  })

  it('applies the whole deadline to stalled response bodies', async () => {
    const url = await receiver((_request, response) => {
      response.writeHead(200)
      response.write('partial')
    })
    const result = await sendWebhook({ ...defaultInput, url, timeoutMs: 80 })
    expect(result).toEqual({ status: 200, responseBody: 'partial', error: 'timeout' })
  })

  it('bounds the DNS phase with the same deadline', async () => {
    lookupAll.mockImplementation(() => new Promise(() => {}))
    const started = performance.now()
    expect(
      await sendWebhook({ ...defaultInput, url: 'https://receiver.example', timeoutMs: 40 }),
    ).toEqual({ status: null, responseBody: '', error: 'timeout' })
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('supports cancellation before and during DNS', async () => {
    const cancelled = AbortSignal.abort(new Error('secret error message'))
    expect(
      await sendWebhook({ ...defaultInput, url: 'https://receiver.example', signal: cancelled }),
    ).toEqual({ status: null, responseBody: '', error: 'aborted' })
    expect(lookup).not.toHaveBeenCalled()
    lookupAll.mockImplementation(() => new Promise(() => {}))
    const controller = new AbortController()
    const pending = sendWebhook({
      ...defaultInput,
      url: 'https://receiver.example',
      signal: controller.signal,
    })
    controller.abort(new Error('another secret'))
    expect(await pending).toEqual({ status: null, responseBody: '', error: 'aborted' })
  })

  it('supports cancellation while reading the response', async () => {
    const controller = new AbortController()
    const url = await receiver((_request, response) => {
      response.writeHead(200)
      response.write('partial')
      setTimeout(() => controller.abort(), 30)
    })
    expect(await sendWebhook({ ...defaultInput, url, signal: controller.signal })).toEqual({
      status: 200,
      responseBody: 'partial',
      error: 'aborted',
    })
  })

  it('normalizes network failures without leaking URLs or exception text', async () => {
    lookupAll.mockRejectedValue(new Error('secret query token from resolver'))
    expect(
      await sendWebhook({ ...defaultInput, url: 'https://receiver.example/?secret=token' }),
    ).toEqual({ status: null, responseBody: '', error: 'dns_error' })
    const url = await receiver((request) => request.socket.destroy())
    expect(await sendWebhook({ ...defaultInput, url })).toEqual({
      status: null,
      responseBody: '',
      error: 'network_error',
    })
  })

  it.each([
    { Host: 'evil.example' },
    { 'content-length': '1' },
    { 'transfer-encoding': 'chunked' },
    { 'webhook-id': 'msg\r\nInjected: yes' },
    { 'bad header': 'value' },
    { 'WebHook-Id': 'one', 'webhook-id': 'two' },
  ])('rejects unsafe or ambiguous outbound headers', async (headers) => {
    const request = vi.spyOn(http, 'request')
    expect(await sendWebhook({ ...defaultInput, url: 'http://127.0.0.1:1', headers })).toEqual({
      status: null,
      responseBody: '',
      error: 'invalid_request',
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects invalid resource limits before attempting a connection', async () => {
    for (const timeoutMs of [0, -1, NaN, 2_147_483_648]) {
      expect(
        await sendWebhook({ ...defaultInput, url: 'http://127.0.0.1', timeoutMs }),
      ).toMatchObject({ error: 'invalid_request' })
    }
    for (const maxResponseBytes of [-1, NaN, 1_048_577]) {
      expect(
        await sendWebhook({ ...defaultInput, url: 'http://127.0.0.1', maxResponseBytes }),
      ).toMatchObject({ error: 'invalid_request' })
    }
  })
})
