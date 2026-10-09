import Link from 'next/link'
import { Code } from '@/components/landing/code'
import { Flow, FlowStep } from '@/components/flow'
import { site } from '@/lib/site'

const sample = `import { createWebhooks } from 'good-webhooks'
import { z } from 'zod'

const webhooks = createWebhooks({
  database: pool, // pg.Pool
  encryptionKey: process.env.WEBHOOK_ENCRYPTION_KEY,
  events: {
    'invoice.paid': z.object({
      invoiceId: z.string(),
      amount: z.number().int(),
    }),
  },
})

// A customer registers an endpoint.
const { secret } = await webhooks.endpoints.create({
  url: 'https://customer.example/webhooks',
  eventTypes: ['invoice.paid'],
})

// Publish a typed event, in your transaction.
await webhooks.publish({
  type: 'invoice.paid',
  data: { invoiceId: 'inv_123', amount: 4200 },
})

// A worker you run signs, sends, and retries.
await webhooks.worker.run({ signal })`

const wire = `POST /webhooks HTTP/1.1
Host: customer.example
Content-Type: application/json
webhook-id: 7a0c3f3e-5b2c-4f8e-9d1a-2e6b8c4d9f10
webhook-timestamp: 1760000000
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj6D2hFcTjqRVo=

{
  "id": "7a0c3f3e-5b2c-4f8e-9d1a-2e6b8c4d9f10",
  "type": "invoice.paid",
  "occurredAt": "2026-10-09T09:46:40.000Z",
  "data": { "invoiceId": "inv_123", "amount": 4200 }
}`

const features: { title: string; body: string }[] = [
  {
    title: 'Typed events.',
    body: 'Any Standard Schema validator. The publisher rejects bad payloads; the receiver decodes into the same types.',
  },
  {
    title: 'Standard Webhooks signing.',
    body: 'webhook-id, webhook-timestamp, and an HMAC-SHA256 signature on every request. Any compliant verifier works.',
  },
  {
    title: 'Transactional publish.',
    body: 'Pass your open PostgreSQL client. If the business write rolls back, the event never existed.',
  },
  {
    title: 'Retries and replay.',
    body: 'Bounded retry schedule, every attempt recorded, replay without changing the event ID.',
  },
  {
    title: 'Better Auth plugin.',
    body: 'Users manage their own endpoints through authenticated routes, with organization permissions.',
  },
  {
    title: 'Bring your own sender.',
    body: 'A two-method EndpointSource contract feeds an existing pipeline with recipients and secrets.',
  },
  {
    title: 'Safe destinations.',
    body: 'URLs validated at registration, addresses re-resolved and pinned per connection, no redirects.',
  },
  {
    title: 'Nothing implicit.',
    body: 'No connections, migrations, or workers start on their own. You own the pool and the process.',
  },
]

const paths: { time: string; title: string; body: string; href: string }[] = [
  {
    time: '2 min read',
    title: 'What it is',
    body: 'The model, the code, and what you still decide.',
    href: '/docs',
  },
  {
    time: '5 min',
    title: 'Try it',
    body: 'One file sends a signed webhook to a local receiver.',
    href: '/docs/quick-start',
  },
  {
    time: '15 min',
    title: 'Add it to your app',
    body: 'Install, create the tables, publish, and run a worker.',
    href: '/docs/installation',
  },
  {
    time: 'Before launch',
    title: 'Go to production',
    body: 'Keys, workers, cleanup, receivers, and upgrades.',
    href: '/docs/operations/production',
  },
]

const setups: { title: string; body: string; href: string }[] = [
  {
    title: 'Standalone on PostgreSQL',
    body: 'Management, publication, and delivery in one package and one database.',
    href: '/docs/quick-start',
  },
  {
    title: 'Better Auth plugin',
    body: 'Signed-in users manage endpoints. Add delivery later or never.',
    href: '/docs/better-auth',
  },
  {
    title: 'Better Auth with delivery',
    body: 'Keep Better Auth for management, add the PostgreSQL worker for sending.',
    href: '/docs/better-auth/delivery',
  },
  {
    title: 'Your own sender',
    body: 'Use either management provider as the recipient source for an existing pipeline.',
    href: '/docs/guides/custom-senders',
  },
]

export default function HomePage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-6 pb-24">
      <section className="grid items-center gap-12 pt-20 lg:min-h-[calc(100vh-14rem)] lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:pt-12">
        <div>
          <p
            className="whitespace-nowrap font-semibold leading-none tracking-tighter text-[clamp(2.5rem,9vw,4rem)] lg:text-[clamp(2.75rem,4.5vw,4rem)]"
            aria-label="good-webhooks"
          >
            good<span className="text-fd-muted-foreground/50">-</span>webhooks
          </p>
          <h1 className="mt-6 max-w-lg text-pretty text-2xl font-normal leading-snug tracking-tight sm:text-3xl">
            Signed, retried, replayable webhooks for TypeScript and PostgreSQL.
          </h1>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/docs/quick-start"
              className="inline-flex h-11 items-center rounded-full bg-fd-primary px-6 text-sm font-medium text-fd-primary-foreground transition-colors hover:bg-fd-primary/85"
            >
              Quick start
            </Link>
            <Link
              href="/docs"
              className="inline-flex h-11 items-center rounded-full bg-fd-secondary px-6 text-sm font-medium transition-colors hover:bg-fd-accent"
            >
              Documentation
            </Link>
            <a
              href={site.githubUrl}
              className="inline-flex h-11 items-center px-3 text-sm font-medium text-fd-muted-foreground transition-colors hover:text-fd-foreground"
            >
              GitHub
            </a>
          </div>
          <p className="mt-10 font-mono text-xs text-fd-muted-foreground">
            v{site.version} · Node.js 24 · PostgreSQL 16+ · MIT
          </p>
        </div>
        <div className="min-w-0">
          <Code code={sample} lang="ts" title="webhooks.ts" />
        </div>
      </section>

      <section className="mt-24">
        <SectionHeading>How it works</SectionHeading>
        <Flow>
          <FlowStep title="Publish" actor="your app">
            <code>publish()</code> validates a typed event and finds subscribed endpoints.
          </FlowStep>
          <FlowStep title="Store" actor="PostgreSQL">
            The event and its deliveries commit with your own data.
          </FlowStep>
          <FlowStep title="Deliver" actor="worker">
            Your worker signs, sends, retries, and records every attempt.
          </FlowStep>
          <FlowStep title="Verify" actor="receiver">
            <code>parseWebhook()</code> checks the signature and returns a typed event.
          </FlowStep>
        </Flow>
      </section>

      <section className="mt-24">
        <SectionHeading>Start here</SectionHeading>
        <div className="mt-4 max-w-xl">
          <Code code="npm install good-webhooks@alpha" lang="bash" />
        </div>
        <div className="grid-cells mt-6 sm:grid-cols-2 lg:grid-cols-4">
          {paths.map((path) => (
            <Link
              key={path.href}
              href={path.href}
              className="flex flex-col p-6 transition-colors hover:bg-fd-accent"
            >
              <span className="font-mono text-xs text-fd-muted-foreground">{path.time}</span>
              <span className="mt-3 font-medium">{path.title}</span>
              <span className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">
                {path.body}
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="mt-24">
        <SectionHeading>Features</SectionHeading>
        <ol className="grid-cells mt-4 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((feature, index) => (
            <li key={feature.title} className="p-6">
              <span className="font-mono text-xs text-fd-muted-foreground">
                {String(index + 1).padStart(2, '0')}
              </span>
              <h3 className="mt-3 font-medium">{feature.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">
                {feature.body}
              </p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-24 grid gap-8 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)]">
        <div>
          <SectionHeading>On the wire</SectionHeading>
          <p className="mt-4 max-w-md leading-relaxed text-fd-muted-foreground">
            A plain HTTPS POST, signed over the exact body bytes and a timestamp. Receivers verify
            with <code className="font-mono text-[0.9em] text-fd-foreground">parseWebhook()</code>{' '}
            or any Standard Webhooks library, then deduplicate by event ID. Retries and replays keep
            the same ID and body.
          </p>
          <Link
            href="/docs/guides/receive"
            className="mt-4 inline-block text-sm font-medium underline underline-offset-4"
          >
            Receive and verify a webhook
          </Link>
        </div>
        <div className="min-w-0">
          <Code code={wire} lang="http" title="Signed request" />
        </div>
      </section>

      <section className="mt-24">
        <SectionHeading>Pick a setup</SectionHeading>
        <div className="grid-cells mt-4 sm:grid-cols-2">
          {setups.map((setup) => (
            <Link
              key={setup.href}
              href={setup.href}
              className="group flex flex-col p-6 transition-colors hover:bg-fd-accent"
            >
              <span className="font-medium">{setup.title}</span>
              <span className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">
                {setup.body}
              </span>
              <span className="mt-4 text-sm underline underline-offset-4 opacity-0 transition-opacity group-hover:opacity-100">
                Open guide
              </span>
            </Link>
          ))}
        </div>
      </section>

      <footer className="mt-24 flex flex-wrap items-center justify-between gap-4 border-t pt-6 font-mono text-xs text-fd-muted-foreground">
        <span>MIT License · pplytas and contributors</span>
        <nav className="flex gap-5">
          <a href={site.githubUrl} className="hover:text-fd-foreground">
            GitHub
          </a>
          <a href={site.npmUrl} className="hover:text-fd-foreground">
            npm
          </a>
          <a href={site.changelogUrl} className="hover:text-fd-foreground">
            Changelog
          </a>
          <Link href="/llms.txt" className="hover:text-fd-foreground">
            llms.txt
          </Link>
        </nav>
      </footer>
    </main>
  )
}

function SectionHeading({ children }: { children: string }) {
  return (
    <h2 className="flex items-center gap-4 text-lg font-medium after:h-px after:flex-1 after:bg-fd-border">
      {children}
    </h2>
  )
}
