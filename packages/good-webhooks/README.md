# Good Webhooks

Send webhooks from your TypeScript application. You publish typed events; Good Webhooks stores them in your PostgreSQL database, delivers signed [Standard Webhooks](https://www.standardwebhooks.com) requests from a worker you run, retries failures, keeps attempt history, and supports replay. Receivers verify requests with one function.

```text
publish()  →  PostgreSQL  →  worker  →  signed POST  →  parseWebhook()
your app      event + deliveries    retries + history      the receiver
```

**[Documentation](https://good-webhooks.vercel.app/docs)** · [Quick start](https://good-webhooks.vercel.app/docs/quick-start) · [API reference](https://good-webhooks.vercel.app/docs/reference) · [For AI agents](https://good-webhooks.vercel.app/docs/ai)

> [!WARNING]
> Alpha. The API can change between releases. Pin the exact version.

## Install

```sh
npm install good-webhooks@alpha pg zod
```

Requires Node.js 24 or later and PostgreSQL 16 or 17. Payload schemas can use any [Standard Schema](https://standardschema.dev) library.

## Use

```ts
import { createWebhooks } from 'good-webhooks'
import { Pool } from 'pg'
import { z } from 'zod'

const webhooks = createWebhooks({
  database: new Pool({ connectionString: process.env.DATABASE_URL }),
  encryptionKey: process.env.WEBHOOK_ENCRYPTION_KEY!, // from generateEncryptionKey(), stored once
  events: {
    'invoice.paid': z.object({ invoiceId: z.string(), amount: z.number().int() }),
  },
})

// A customer registers an endpoint. The signing secret is returned once.
const { secret } = await webhooks.endpoints.create({
  url: 'https://customer.example/webhooks',
  eventTypes: ['invoice.paid'],
})

// Publish a typed event, optionally inside your own transaction.
await webhooks.publish({
  type: 'invoice.paid',
  data: { invoiceId: 'inv_123', amount: 4200 },
  idempotencyKey: 'invoice.paid:inv_123',
})

// In a separate process: sign, send, and retry until stopped.
await webhooks.worker.run({ signal })
```

The receiver verifies the raw body and gets a typed event:

```ts
import { parseWebhook } from 'good-webhooks/verify'

const event = await parseWebhook({ body: rawBody, headers, secret, events })
```

Apply the SQL from `getPostgresMigration()` (in `good-webhooks/migrations`) with your migration tool first. Nothing runs implicitly: no connections, migrations, or workers start on their own.

## Setups

| You want                                     | Start with                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| Everything on PostgreSQL                     | [Quick start](https://good-webhooks.vercel.app/docs/quick-start)              |
| Signed-in users managing their own endpoints | [Better Auth plugin](https://good-webhooks.vercel.app/docs/better-auth)       |
| Better Auth endpoints with built-in delivery | [Add delivery](https://good-webhooks.vercel.app/docs/better-auth/delivery)    |
| Endpoint management for your own sender      | [Custom senders](https://good-webhooks.vercel.app/docs/guides/custom-senders) |
| Only receiving webhooks                      | [Receive webhooks](https://good-webhooks.vercel.app/docs/guides/receive)      |

Better Auth `>=1.7.7 <1.8.0` is an optional peer dependency. TypeScript consumers need 5.9.3 or later with `NodeNext` or `Bundler` resolution.

## For AI agents

This package ships an [Agent Skill](https://agentskills.io) in `skills/good-webhooks/` that matches the installed version. Docs for agents: [llms.txt](https://good-webhooks.vercel.app/llms.txt).

## Guarantees

Delivery is at least once, with no ordering. Receivers must verify signatures and record each event ID with their change. See [delivery guarantees](https://good-webhooks.vercel.app/docs/concepts/delivery-guarantees).

MIT licensed. See the [contribution guide](https://github.com/pplytas/good-webhooks/blob/main/CONTRIBUTING.md) and [security policy](https://github.com/pplytas/good-webhooks/blob/main/SECURITY.md).
