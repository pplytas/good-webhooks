import type { ReactNode } from 'react'
import Link from 'next/link'
import { Code } from '@/components/landing/code'
import { CodeTabs } from '@/components/landing/code-tabs'
import { Delivery } from '@/components/landing/delivery'
import { Install } from '@/components/landing/install'
import { SetupDiagram } from '@/components/landing/setup-diagram'
import { Wire } from '@/components/landing/wire'
import {
  BetterAuth,
  NothingImplicit,
  OwnSender,
  Retries,
  SafeDestinations,
  Signing,
  Transactional,
  TypedEvents,
} from '@/components/landing/illustrations'
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

const publish = `import { createWebhooks } from 'good-webhooks'
import { z } from 'zod'

export const webhooks = createWebhooks({
  database: pool, // pg.Pool
  encryptionKey: process.env.WEBHOOK_ENCRYPTION_KEY,
  events: {
    'invoice.paid': z.object({
      invoiceId: z.string(),
      amount: z.number().int(),
    }),
  },
})

// Inside the transaction that marks the invoice paid.
await webhooks.publish(
  {
    type: 'invoice.paid',
    data: { invoiceId: 'inv_123', amount: 4200 },
  },
  { transaction: client },
)`

const publishBetterAuth = `import { createDelivery } from 'good-webhooks/delivery'
import {
  createBetterAuthManagement,
} from 'good-webhooks/better-auth'
import { z } from 'zod'
import { auth } from './auth'

const management = await createBetterAuthManagement(auth)

export const delivery = createDelivery({
  database: pool, // pg.Pool
  source: management.source,
  events: {
    'invoice.paid': z.object({
      invoiceId: z.string(),
      amount: z.number().int(),
    }),
  },
})

// In the signed-in user's scope: their endpoints, nobody else's.
await delivery.forScope({ type: 'user', id: user.id }).publish({
  type: 'invoice.paid',
  data: { invoiceId: 'inv_123', amount: 4200 },
})`

const receiveNext = `import { parseWebhook, WebhookError } from 'good-webhooks/verify'
import { events } from './events'

export async function POST(request: Request) {
  try {
    const event = await parseWebhook({
      body: new Uint8Array(await request.arrayBuffer()),
      headers: request.headers,
      secret: process.env.WEBHOOK_SECRET!,
      events,
    })
    // event.type is 'invoice.paid'; event.data is typed.
    return new Response(null, { status: 204 })
  } catch (error) {
    if (error instanceof WebhookError) {
      return new Response('Invalid webhook', { status: 400 })
    }
    throw error // 500: the sender retries.
  }
}`

const receiveHono = `import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { parseWebhook, WebhookError } from 'good-webhooks/verify'
import { events } from './events'

const app = new Hono()
const limit = bodyLimit({ maxSize: 512 * 1024 })

app.post('/webhooks', limit, async (c) => {
  try {
    const event = await parseWebhook({
      body: new Uint8Array(await c.req.arrayBuffer()),
      headers: c.req.raw.headers,
      secret: process.env.WEBHOOK_SECRET!,
      events,
    })
    // event.type is 'invoice.paid'; event.data is typed.
    return c.body(null, 204)
  } catch (error) {
    if (error instanceof WebhookError) {
      return c.text('Invalid webhook', 400)
    }
    throw error // 500: the sender retries.
  }
})

export default app`

const receiveExpress = `import express from 'express'
import { parseWebhook, WebhookError } from 'good-webhooks/verify'
import { events } from './events'

const app = express()

// Raw bytes, not parsed JSON: the signature covers the exact body.
const raw = express.raw({
  type: 'application/json',
  limit: '512kb',
})

app.post('/webhooks', raw, async (req, res) => {
  try {
    const event = await parseWebhook({
      body: req.body,
      headers: req.headers,
      secret: process.env.WEBHOOK_SECRET!,
      events,
    })
    // event.type is 'invoice.paid'; event.data is typed.
    res.sendStatus(204)
  } catch (error) {
    if (error instanceof WebhookError) {
      return res.status(400).send('Invalid webhook')
    }
    throw error // Express 5 answers 500: the sender retries.
  }
})

app.listen(3000)`

/** What the package is built on and built for. The honest version of a logo wall. */
const examples: {
  title: string
  body: string
  href: string
  diagram: { from: string[]; through: string; to: string[] }
}[] = [
  {
    title: 'Order fulfillment',
    body: 'A shop sends orders to a warehouse. Place an order in the browser and watch the worker deliver it.',
    href: 'https://github.com/pplytas/good-webhooks/tree/main/examples/order-fulfillment',
    diagram: { from: ['shop order'], through: 'worker', to: ['warehouse'] },
  },
  {
    title: 'Better Auth billing',
    body: 'Users sign in, register their own endpoints, and receive invoice events from a separate worker.',
    href: 'https://github.com/pplytas/good-webhooks/tree/main/examples/better-auth-billing',
    diagram: { from: ['user', 'invoice.paid'], through: 'Better Auth', to: ['their endpoint'] },
  },
]

const steps: { title: string; body: ReactNode }[] = [
  {
    title: 'Publish',
    body: (
      <>
        <code>publish()</code> validates a typed event and finds subscribed endpoints.
      </>
    ),
  },
  {
    title: 'Store',
    body: 'The event and its deliveries commit with your own data.',
  },
  {
    title: 'Deliver',
    body: 'Your worker signs, sends, retries, and records every attempt.',
  },
  {
    title: 'Verify',
    body: (
      <>
        <code>parseWebhook()</code> checks the signature and returns a typed event.
      </>
    ),
  },
]

const features: { title: string; body: string; art: ReactNode }[] = [
  {
    title: 'Typed events',
    art: <TypedEvents />,
    body: 'Any Standard Schema validator. The publisher rejects bad payloads; the receiver decodes into the same types.',
  },
  {
    title: 'Standard Webhooks signing',
    art: <Signing />,
    body: 'webhook-id, webhook-timestamp, and an HMAC-SHA256 signature on every request. Any compliant verifier works.',
  },
  {
    title: 'Transactional publish',
    art: <Transactional />,
    body: 'Pass your open PostgreSQL client. If the business write rolls back, the event never existed.',
  },
  {
    title: 'Retries and replay',
    art: <Retries />,
    body: 'Bounded retry schedule, every attempt recorded, replay without changing the event ID.',
  },
  {
    title: 'Better Auth plugin',
    art: <BetterAuth />,
    body: 'Users manage their own endpoints through authenticated routes, with organization permissions.',
  },
  {
    title: 'Bring your own sender',
    art: <OwnSender />,
    body: 'A two-method EndpointSource contract feeds an existing pipeline with recipients and secrets.',
  },
  {
    title: 'Safe destinations',
    art: <SafeDestinations />,
    body: 'URLs validated at registration, addresses re-resolved and pinned per connection, no redirects.',
  },
  {
    title: 'Nothing implicit',
    art: <NothingImplicit />,
    body: 'No connections, migrations, or workers start on their own. You own the pool and the process.',
  },
]

const setups: {
  title: string
  body: string
  href: string
  diagram: { from: string[]; through: string; to: string[] }
}[] = [
  {
    title: 'Standalone on PostgreSQL',
    body: 'Management, publication, and delivery in one package and one database.',
    href: '/docs/quick-start',
    diagram: {
      from: ['endpoints', 'publish()'],
      through: 'PostgreSQL',
      to: ['customer A', 'customer B', 'customer C'],
    },
  },
  {
    title: 'Better Auth plugin',
    body: 'Signed-in users manage endpoints. Add delivery later or never.',
    href: '/docs/better-auth',
    diagram: { from: ['user', 'organization'], through: 'Better Auth', to: ['endpoints'] },
  },
  {
    title: 'Better Auth with delivery',
    body: 'Keep Better Auth for management, add the PostgreSQL worker for sending.',
    href: '/docs/better-auth/delivery',
    diagram: {
      from: ['Better Auth', 'publish()'],
      through: 'worker',
      to: ['customer A', 'customer B', 'customer C'],
    },
  },
  {
    title: 'Your own sender',
    body: 'Use either management provider as the recipient source for an existing pipeline.',
    href: '/docs/guides/custom-senders',
    diagram: {
      from: ['Better Auth', 'PostgreSQL'],
      through: 'EndpointSource',
      to: ['your sender'],
    },
  },
]

// A reading order, so the list is numbered.
const paths: { title: string; body: string; href: string }[] = [
  {
    title: 'What it is',
    body: 'The model, the code, and what you still decide.',
    href: '/docs',
  },
  {
    title: 'Try it',
    body: 'One file sends a signed webhook to a local receiver.',
    href: '/docs/quick-start',
  },
  {
    title: 'Add it to your app',
    body: 'Install, create the tables, publish, and run a worker.',
    href: '/docs/installation',
  },
  {
    title: 'Go to production',
    body: 'Keys, workers, cleanup, receivers, and upgrades.',
    href: '/docs/operations/production',
  },
]

export default function HomePage() {
  return (
    <main className="mx-auto w-full max-w-7xl px-6 pb-32">
      <section className="pt-16 sm:pt-24">
        <div className="grid items-start gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-x-16">
          <div className="lg:pt-2">
            <h1 className="text-balance text-[clamp(2.25rem,4.2vw,3.5rem)] font-semibold leading-[1.05] tracking-[-0.03em]">
              Signed, retried, replayable webhooks.
            </h1>
            <p className="mt-7 max-w-lg text-pretty text-lg leading-relaxed text-fd-muted-foreground">
              Publish typed events from your TypeScript app. Good Webhooks stores them in your
              PostgreSQL database and delivers them as signed Standard Webhooks requests, with
              retries and a record of every attempt.
            </p>
            <div className="mt-10 flex flex-wrap items-center gap-3">
              <Link
                href="/docs/quick-start"
                className="pressable inline-flex h-11 items-center rounded-full bg-fd-primary px-6 text-sm font-medium text-fd-primary-foreground transition-[transform,background-color] duration-150 ease-out hover:bg-fd-primary/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring focus-visible:ring-offset-2 focus-visible:ring-offset-fd-background"
              >
                Quick start
              </Link>
              <Link
                href="/docs"
                className="pressable inline-flex h-11 items-center rounded-full bg-fd-secondary px-6 text-sm font-medium transition-[transform,background-color] duration-150 ease-out hover:bg-fd-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring focus-visible:ring-offset-2 focus-visible:ring-offset-fd-background"
              >
                Read the docs
              </Link>
            </div>
            <div className="mt-8">
              <Install />
            </div>
          </div>
          <div className="min-w-0">
            <Code code={sample} lang="ts" />
          </div>
        </div>

        <div className="mt-16 sm:mt-24">
          <Delivery>
            <ol className="grid gap-x-6 gap-y-5 border-t px-5 py-5 sm:px-6 md:grid-cols-4">
              {steps.map((step) => (
                <li key={step.title} className="text-sm leading-relaxed">
                  <span className="font-medium">{step.title}</span>{' '}
                  <span className="text-fd-muted-foreground [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:text-fd-foreground">
                    {step.body}
                  </span>
                </li>
              ))}
            </ol>
          </Delivery>
        </div>
      </section>

      <section className="mt-24 border-t pt-20 sm:mt-32 sm:pt-28">
        <SectionHeading lede="The client validates the payload against your schema and records the event inside your transaction. The receiver imports only the verify module and checks the signature in one call.">
          Publish on your side. Verify on theirs.
        </SectionHeading>
        <div className="mt-12 grid items-start gap-8 lg:grid-cols-2">
          <div className="min-w-0">
            <CodeTabs
              tabs={[
                {
                  label: 'PostgreSQL',
                  content: <Code code={publish} lang="ts" title="webhooks.ts" />,
                },
                {
                  label: 'Better Auth',
                  content: <Code code={publishBetterAuth} lang="ts" title="delivery.ts" />,
                },
              ]}
            />
          </div>
          <div className="min-w-0">
            <CodeTabs
              tabs={[
                {
                  label: 'Next.js',
                  content: <Code code={receiveNext} lang="ts" title="app/webhooks/route.ts" />,
                },
                { label: 'Hono', content: <Code code={receiveHono} lang="ts" title="server.ts" /> },
                {
                  label: 'Express',
                  content: <Code code={receiveExpress} lang="ts" title="server.ts" />,
                },
              ]}
            />
          </div>
        </div>
      </section>

      <section className="mt-24 border-t pt-20 sm:mt-32 sm:pt-28">
        <SectionHeading lede="A plain HTTPS POST, signed over the exact body bytes and a timestamp. Any Standard Webhooks library can verify it. Point at a header to see what it covers.">
          On the wire
        </SectionHeading>
        <div className="mt-12">
          <Wire />
        </div>
        <Link href="/docs/guides/receive" className="link mt-8 inline-block text-sm">
          Receive and verify a webhook
        </Link>
      </section>

      <section className="mt-24 border-t pt-20 sm:mt-32 sm:pt-28">
        <SectionHeading lede="The parts of delivery that are tedious to get right, done once and tested.">
          What you get
        </SectionHeading>
        <ul className="grid-cells mt-12 sm:grid-cols-2 xl:grid-cols-4">
          {features.map((feature) => (
            <li key={feature.title} className="flex flex-col">
              {feature.art}
              <h3 className="px-5 pt-4 font-medium">{feature.title}</h3>
              <p className="px-5 pb-5 pt-1.5 text-sm leading-relaxed text-fd-muted-foreground">
                {feature.body}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-24 border-t pt-20 sm:mt-32 sm:pt-28">
        <SectionHeading lede="Endpoint management and delivery are separate pieces. Take both, or just the one you are missing.">
          Pick a setup
        </SectionHeading>
        <div className="grid-cells mt-12 sm:grid-cols-2">
          {setups.map((setup) => (
            <Link
              key={setup.href}
              href={setup.href}
              className="group flex flex-col transition-colors duration-150 ease-out hover:bg-fd-accent"
            >
              <span className="border-b bg-fd-card px-4 py-4 transition-colors duration-150 ease-out group-hover:bg-fd-accent sm:px-6">
                <SetupDiagram {...setup.diagram} />
              </span>
              <span className="px-5 pt-5 font-medium sm:px-6">
                <span className="link">{setup.title}</span>
              </span>
              <span className="mt-2 px-5 pb-5 text-sm leading-relaxed text-fd-muted-foreground sm:px-6 sm:pb-6">
                {setup.body}
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="mt-24 border-t pt-20 sm:mt-32 sm:pt-28">
        <SectionHeading lede="Two applications in the repository install the published package and show the full path from a business action to a verified webhook. Copy either one into your own project.">
          Run a complete application
        </SectionHeading>
        <div className="grid-cells mt-12 sm:grid-cols-2">
          {examples.map((example) => (
            <a
              key={example.href}
              href={example.href}
              className="group flex flex-col transition-colors duration-150 ease-out hover:bg-fd-accent"
            >
              <span className="border-b bg-fd-card px-4 py-4 transition-colors duration-150 ease-out group-hover:bg-fd-accent sm:px-6">
                <SetupDiagram {...example.diagram} />
              </span>
              <span className="px-5 pt-5 font-medium sm:px-6">
                <span className="link">{example.title}</span>
              </span>
              <span className="mt-2 px-5 pb-5 text-sm leading-relaxed text-fd-muted-foreground sm:px-6 sm:pb-6">
                {example.body}
              </span>
            </a>
          ))}
        </div>
      </section>

      <section className="mt-24 border-t pt-20 sm:mt-32 sm:pt-28">
        <SectionHeading>Start here</SectionHeading>
        <ol className="mt-10 border-t">
          {paths.map((path) => (
            <li key={path.href} className="border-b">
              <Link
                href={path.href}
                className="group grid gap-x-6 gap-y-1 py-5 sm:grid-cols-[12rem_1fr] sm:items-baseline"
              >
                <span className="link">{path.title}</span>
                <span className="text-sm text-fd-muted-foreground">{path.body}</span>
              </Link>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-36 rounded-xl border bg-fd-card p-8 sm:mt-44 sm:p-12">
        <div className="max-w-xl">
          <h2 className="text-2xl font-semibold leading-tight tracking-tight sm:text-[1.75rem]">
            Send your first signed webhook in five minutes.
          </h2>
          <p className="mt-3 max-w-md text-pretty leading-relaxed text-fd-muted-foreground">
            One file publishes an event and a local receiver verifies it. Nothing to sign up for.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link
              href="/docs/quick-start"
              className="pressable inline-flex h-11 items-center rounded-full bg-fd-primary px-6 text-sm font-medium text-fd-primary-foreground transition-[transform,background-color] duration-150 ease-out hover:bg-fd-primary/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring focus-visible:ring-offset-2 focus-visible:ring-offset-fd-card"
            >
              Quick start
            </Link>
            <a
              href={site.githubUrl}
              className="pressable inline-flex h-11 items-center rounded-full bg-fd-secondary px-6 text-sm font-medium transition-[transform,background-color] duration-150 ease-out hover:bg-fd-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring focus-visible:ring-offset-2 focus-visible:ring-offset-fd-card"
            >
              Star on GitHub
            </a>
          </div>
        </div>
      </section>

      <footer className="mt-28 flex flex-wrap items-center justify-between gap-4 pt-6 font-mono text-xs text-fd-muted-foreground">
        <span>MIT License, pplytas and contributors</span>
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

function SectionHeading({ children, lede }: { children: string; lede?: string }) {
  return (
    <div className="max-w-2xl">
      <h2 className="text-2xl font-semibold leading-tight tracking-tight sm:text-[1.75rem]">
        {children}
      </h2>
      {lede ? (
        <p className="mt-4 text-pretty leading-relaxed text-fd-muted-foreground">{lede}</p>
      ) : null}
    </div>
  )
}
