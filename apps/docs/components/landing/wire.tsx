'use client'

import Link from 'next/link'
import { useState } from 'react'

/**
 * A signed request and what each signed header means. Selecting a header lights the lines of
 * the request it refers to, and pointing at a signed line selects its header, so the
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
  { name: 'Host', text: 'receiver.example' },
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
  // One header is always selected, so the drawing never sits unlit and the list reads as a picker.
  const [active, setActive] = useState<Part>('id')
  const lit = (parts?: Part[]) => parts?.includes(active)
  const select = (part: Part) => ({
    onPointerEnter: () => setActive(part),
    onFocus: () => setActive(part),
  })

  return (
    <div className="grid gap-x-12 gap-y-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <ul aria-label="Signed headers" className="flex flex-col divide-y border">
        {definitions.map((definition) => (
          <li key={definition.part} className="flex lg:flex-1">
            <button
              type="button"
              aria-pressed={active === definition.part}
              onClick={() => setActive(definition.part)}
              {...select(definition.part)}
              className="group flex w-full flex-col justify-center px-5 py-4 text-left transition-colors duration-150 ease-out hover:bg-fd-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-fd-ring aria-pressed:bg-fd-primary/[0.06] aria-pressed:shadow-[inset_2px_0_0_var(--color-fd-primary)]"
            >
              <span className="flex items-center gap-2.5 font-mono text-[13px] text-fd-foreground">
                <span
                  aria-hidden
                  className="size-1.5 bg-fd-muted-foreground/40 transition-colors duration-150 ease-out group-aria-pressed:bg-fd-primary"
                />
                {definition.name}
              </span>
              <span className="mt-1.5 block pl-4 text-sm leading-relaxed text-fd-muted-foreground">
                {definition.body}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="min-w-0 overflow-hidden border bg-fd-card">
        <div className="flex items-center justify-between gap-4 border-b px-5 py-3 text-xs text-fd-muted-foreground">
          <span className="font-mono uppercase tracking-wider">Signed request</span>
          <Link
            href="/docs/guides/receive"
            className="group inline-flex items-center gap-1 transition-colors duration-150 ease-out hover:text-fd-foreground"
          >
            How to verify it
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="size-3 transition-transform duration-150 ease-out motion-safe:group-hover:translate-x-0.5"
            >
              <path d="M3 8h10M9 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
        </div>
        <ol className="px-3 py-4 font-mono text-[13px] leading-6 max-sm:text-xs">
          {lines.map((line, index) => (
            <li
              key={index}
              {...(line.signed ? select(line.parts![0]!) : {})}
              className={`flex gap-2 px-2 transition-colors duration-150 ease-out max-sm:flex-wrap ${
                lit(line.parts) ? 'bg-fd-primary/10' : ''
              }`}
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
                {line.text || ' '}
              </span>
            </li>
          ))}
        </ol>
        <p className="border-t px-5 py-3.5 font-mono text-xs leading-relaxed text-fd-muted-foreground">
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
    </div>
  )
}
