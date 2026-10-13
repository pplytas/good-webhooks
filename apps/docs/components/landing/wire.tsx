'use client'

import { useState } from 'react'

/**
 * A signed request and what each signed header means. Pointing at a definition lights the
 * lines of the request it refers to, and pointing at a line lights its definition, so the
 * relationship between the three headers, the body, and the signature is read from the
 * drawing rather than explained. Nothing moves: a background tint changes.
 */
type Part = 'id' | 'timestamp' | 'signature'

const id = '7a0c3f3e-5b2c-4f8e-9d1a-2e6b8c4d9f10'
const timestamp = '1760000000'
const signature = 'v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj6D2hFcTjqRVo='

/** Which parts light a line. The signature covers everything it was computed over. */
const lines: { text: string; name?: string; parts?: Part[]; signed?: boolean }[] = [
  { text: 'POST /webhooks HTTP/1.1' },
  { name: 'Host', text: 'customer.example' },
  { name: 'Content-Type', text: 'application/json' },
  { name: 'webhook-id', text: id, parts: ['id', 'signature'], signed: true },
  { name: 'webhook-timestamp', text: timestamp, parts: ['timestamp', 'signature'], signed: true },
  { name: 'webhook-signature', text: signature, parts: ['signature'], signed: true },
  { text: '' },
  { text: '{', parts: ['signature'] },
  { text: `  "id": "${id}",`, parts: ['id', 'signature'] },
  { text: '  "type": "invoice.paid",', parts: ['signature'] },
  { text: '  "occurredAt": "2026-10-09T09:46:40.000Z",', parts: ['signature'] },
  { text: '  "data": { "invoiceId": "inv_123", "amount": 4200 }', parts: ['signature'] },
  { text: '}', parts: ['signature'] },
]

const definitions: { part: Part; name: string; body: string }[] = [
  {
    part: 'id',
    name: 'webhook-id',
    body: 'The event ID, repeated in the body. Retries and replays send it again unchanged, so receivers deduplicate on it.',
  },
  {
    part: 'timestamp',
    name: 'webhook-timestamp',
    body: 'When the request was signed. Receivers reject anything older than five minutes by default.',
  },
  {
    part: 'signature',
    name: 'webhook-signature',
    body: 'HMAC-SHA256 over the ID, the timestamp, and the exact body bytes, keyed with the endpoint secret.',
  },
]

export function Wire() {
  const [active, setActive] = useState<Part | null>(null)
  const lit = (parts?: Part[]) => active !== null && parts?.includes(active)
  const point = (part: Part | null) => ({
    onPointerEnter: () => setActive(part),
    onPointerLeave: () => setActive(null),
    onFocus: () => setActive(part),
    onBlur: () => setActive(null),
  })

  return (
    <div className="grid gap-x-16 gap-y-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
      <div className="min-w-0 overflow-hidden rounded-xl border bg-fd-card">
        <div className="border-b px-4 py-2.5 text-xs text-fd-muted-foreground">Signed request</div>
        <ol className="px-2 py-3 font-mono text-[13px] leading-6 max-sm:text-xs">
          {lines.map((line, index) => (
            <li
              key={index}
              tabIndex={line.signed ? 0 : undefined}
              {...(line.signed ? point(line.parts![0]!) : {})}
              className={`flex gap-2 rounded-md px-2 transition-colors duration-150 ease-out max-sm:flex-wrap ${
                lit(line.parts) ? 'bg-fd-primary/10' : ''
              } ${line.signed ? 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-fd-ring' : ''}`}
            >
              {line.name ? (
                <span
                  className={`shrink-0 ${line.signed ? 'text-fd-foreground' : 'text-fd-muted-foreground'}`}
                >
                  {line.name}:
                </span>
              ) : null}
              <span
                className={`min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] ${
                  line.name ? 'text-fd-muted-foreground' : 'text-fd-foreground'
                }`}
              >
                {line.text || ' '}
              </span>
            </li>
          ))}
        </ol>
        <p className="border-t px-4 py-3 font-mono text-xs leading-relaxed text-fd-muted-foreground">
          <span className={active === 'signature' ? 'text-fd-foreground' : ''}>
            webhook-signature
          </span>{' '}
          = v1, base64( HMAC-SHA256( secret,{' '}
          <span className={active === 'id' || active === 'signature' ? 'text-fd-foreground' : ''}>
            id
          </span>
          .
          <span
            className={active === 'timestamp' || active === 'signature' ? 'text-fd-foreground' : ''}
          >
            timestamp
          </span>
          .<span className={active === 'signature' ? 'text-fd-foreground' : ''}>body</span> ) )
        </p>
      </div>

      <dl className="divide-y border-y lg:self-start">
        {definitions.map((definition) => (
          <div
            key={definition.part}
            tabIndex={0}
            {...point(definition.part)}
            className={`-mx-2 grid gap-1 rounded-md px-2 py-4 transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring sm:grid-cols-[11rem_1fr] sm:gap-4 ${
              active === definition.part ? 'bg-fd-primary/10' : ''
            }`}
          >
            <dt className="font-mono text-[13px] text-fd-foreground">{definition.name}</dt>
            <dd className="text-sm leading-relaxed text-fd-muted-foreground">{definition.body}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
