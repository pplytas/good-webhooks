import type { ReactNode } from 'react'

/**
 * One small drawing per feature cell, after the mini-UI headers on the Better Auth and
 * Clerk feature grids. Each is decorative: the title and body below it carry the words.
 * Everything is monospace at 11px on the card surface, in the theme's own colors, so the
 * drawings read as the product's data rather than as stock illustration. Phones skip them:
 * eight stacked drawings would double the page.
 */

function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      aria-hidden="true"
      className="hidden h-32 items-center justify-center overflow-hidden border-b bg-fd-card sm:flex px-5 font-mono text-[11px] leading-5 text-fd-muted-foreground"
    >
      {children}
    </div>
  )
}

function Yes({ children }: { children: string }) {
  return (
    <span className="whitespace-nowrap text-fd-primary">
      <span className="mr-1">✓</span>
      {children}
    </span>
  )
}

function No({ children }: { children: string }) {
  return (
    <span className="whitespace-nowrap">
      <span className="mr-1">✕</span>
      {children}
    </span>
  )
}

export function TypedEvents() {
  return (
    <Frame>
      <div className="w-full max-w-[16rem] space-y-1.5">
        <p className="text-fd-foreground">'invoice.paid'</p>
        <p className="flex justify-between gap-3">
          <span className="truncate">{'{ amount: 4200 }'}</span>
          <Yes>published</Yes>
        </p>
        <p className="flex justify-between gap-3">
          <span className="truncate line-through decoration-fd-border">{'{ amount: "4200" }'}</span>
          <No>rejected</No>
        </p>
      </div>
    </Frame>
  )
}

export function Signing() {
  const headers: [string, string, boolean][] = [
    ['webhook-id', '7a0c3f3e-5b2c…', false],
    ['webhook-timestamp', '1760000000', false],
    ['webhook-signature', 'v1,K5oZfzN9…', true],
  ]
  return (
    <Frame>
      <div className="w-full max-w-[16rem]">
        {headers.map(([key, value, highlight]) => (
          <p
            key={key}
            className={`flex justify-between gap-3 px-1.5 ${highlight ? 'bg-fd-primary/10 text-fd-foreground' : ''}`}
          >
            <span className="shrink-0">{key}</span>
            <span className="truncate">{value}</span>
          </p>
        ))}
      </div>
    </Frame>
  )
}

export function Transactional() {
  return (
    <Frame>
      <div className="w-full max-w-[16rem]">
        <p className="text-fd-foreground">BEGIN</p>
        <div className="ml-1 border-l-2 border-fd-primary pl-3">
          <p>INSERT INTO invoices …</p>
          <p>publish('invoice.paid')</p>
        </div>
        <p className="text-fd-foreground">COMMIT</p>
      </div>
    </Frame>
  )
}

export function Retries() {
  // Attempt positions spread like the default schedule: 1s, 5s, 30s between tries.
  const attempts: { x: number; status: string; ok?: boolean }[] = [
    { x: 16, status: '503' },
    { x: 48, status: '503' },
    { x: 98, status: '503' },
    { x: 182, status: '200', ok: true },
  ]
  const delays: { x: number; label: string }[] = [
    { x: 32, label: '1s' },
    { x: 73, label: '5s' },
    { x: 140, label: '30s' },
  ]
  return (
    <Frame>
      <svg viewBox="0 0 240 60" className="h-auto w-full max-w-[15rem]">
        <line x1={16} y1={28} x2={182} y2={28} className="stroke-fd-border" strokeWidth={2} />
        {delays.map((delay) => (
          <text
            key={delay.label}
            x={delay.x}
            y={14}
            textAnchor="middle"
            className="fill-fd-muted-foreground text-[9px]"
          >
            {delay.label}
          </text>
        ))}
        {attempts.map((attempt) => (
          <g key={attempt.x}>
            <circle
              cx={attempt.x}
              cy={28}
              r={5}
              className={attempt.ok ? 'fill-fd-primary' : 'fill-fd-card stroke-fd-muted-foreground'}
              strokeWidth={1.5}
            />
            <text
              x={attempt.x}
              y={50}
              textAnchor="middle"
              className={`text-[10px] ${attempt.ok ? 'fill-fd-foreground' : 'fill-fd-muted-foreground'}`}
            >
              {attempt.status}
            </text>
          </g>
        ))}
        <circle
          cx={222}
          cy={28}
          r={5}
          className="fill-none stroke-fd-primary"
          strokeWidth={1.5}
          strokeDasharray="2.5 2"
        />
        <text x={222} y={50} textAnchor="middle" className="fill-fd-muted-foreground text-[10px]">
          replay
        </text>
      </svg>
    </Frame>
  )
}

export function BetterAuth() {
  const rows: [string, string, boolean][] = [
    ['acme.dev/webhooks', 'invoice.paid', true],
    ['api.acme.dev/hooks', 'invoice.*', true],
    ['staging.acme.dev', 'invoice.paid', false],
  ]
  return (
    <Frame>
      <div className="w-full max-w-[16rem]">
        {rows.map(([url, events, active]) => (
          <p key={url} className="flex items-center gap-2">
            <span
              className={`size-1.5 shrink-0 rounded-full ${active ? 'bg-fd-primary' : 'border border-fd-muted-foreground'}`}
            />
            <span className="truncate text-fd-foreground">{url}</span>
            <span className="ml-auto shrink-0">{events}</span>
          </p>
        ))}
      </div>
    </Frame>
  )
}

export function OwnSender() {
  return (
    <Frame>
      <div className="w-full max-w-[16rem]">
        <p className="flex items-center gap-2">
          <span className="text-fd-foreground">EndpointSource</span>
          <svg
            viewBox="0 0 24 8"
            className="w-6 shrink-0 stroke-fd-muted-foreground/60"
            fill="none"
          >
            <path d="M0 4h22M18 1l4 3-4 3" />
          </svg>
          <span className="shrink-0 bg-fd-primary px-2.5 text-fd-primary-foreground">
            your sender
          </span>
        </p>
        <p>matchRecipients()</p>
        <p>resolveEndpoint()</p>
      </div>
    </Frame>
  )
}

export function SafeDestinations() {
  return (
    <Frame>
      <div className="w-full max-w-[16rem]">
        <p className="truncate text-fd-foreground">https://receiver.example/webhooks</p>
        <div className="mt-1.5 grid grid-cols-2 gap-x-4">
          <Yes>https</Yes>
          <Yes>public address</Yes>
          <Yes>address pinned</Yes>
          <No>redirects</No>
        </div>
      </div>
    </Frame>
  )
}

export function NothingImplicit() {
  const rows: [string, string][] = [
    ['pool', 'yours, passed in'],
    ['tables', 'you apply the SQL'],
    ['worker', 'you start it'],
  ]
  return (
    <Frame>
      <div className="w-full max-w-[16rem]">
        {rows.map(([key, value]) => (
          <p key={key} className="flex justify-between gap-3">
            <span className="text-fd-foreground">{key}</span>
            <span>{value}</span>
          </p>
        ))}
      </div>
    </Frame>
  )
}
