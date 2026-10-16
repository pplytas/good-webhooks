<p align="center">
  <img alt="" src="https://good-webhooks.dev/readme/mark-square.png" width="56" height="56" />
</p>

<h1 align="center">Good Webhooks</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/good-webhooks"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/npm/v/good-webhooks.svg?size=xs&mode=dark&font=geist" /><img alt="npm version" src="https://shieldcn.dev/npm/v/good-webhooks.svg?size=xs&mode=light&font=geist" /></picture></a>
  <a href="https://www.npmjs.com/package/good-webhooks"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/npm/dw/good-webhooks.svg?variant=secondary&size=xs&mode=dark&font=geist" /><img alt="npm downloads" src="https://shieldcn.dev/npm/dw/good-webhooks.svg?variant=secondary&size=xs&mode=light&font=geist" /></picture></a>
  <a href="https://github.com/pplytas/good-webhooks/blob/main/LICENSE"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/license/pplytas/good-webhooks.svg?variant=secondary&size=xs&mode=dark&font=geist" /><img alt="MIT license" src="https://shieldcn.dev/github/license/pplytas/good-webhooks.svg?variant=secondary&size=xs&mode=light&font=geist" /></picture></a>
  <a href="https://github.com/pplytas/good-webhooks/actions/workflows/ci.yml"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/ci/pplytas/good-webhooks.svg?workflow=ci.yml&branch=main&variant=secondary&size=xs&mode=dark&font=geist" /><img alt="CI status" src="https://shieldcn.dev/github/ci/pplytas/good-webhooks.svg?workflow=ci.yml&branch=main&variant=secondary&size=xs&mode=light&font=geist" /></picture></a>
</p>

<p align="center">
  Build webhook delivery into your TypeScript application.
</p>

<p align="center">
  <a href="https://good-webhooks.dev/docs"><b>Documentation</b></a> ·
  <a href="https://good-webhooks.dev/docs/quick-start">Quick start</a> ·
  <a href="https://good-webhooks.dev/docs/reference">API reference</a> ·
  <a href="https://good-webhooks.dev/docs/ai">For AI agents</a>
</p>

You publish typed events. Good Webhooks stores them in your PostgreSQL database, and a worker you run delivers signed [Standard Webhooks](https://www.standardwebhooks.com) requests, retries failures, and records every attempt. Receivers verify a request with one function.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://good-webhooks.dev/readme/pipeline-dark.png" />
    <img alt="Your app calls publish(), which records the event and one delivery per endpoint in PostgreSQL. A worker signs, sends, retries, and records each delivery. The receiver calls parseWebhook() to verify it and get a typed event." src="https://good-webhooks.dev/readme/pipeline-light.png" />
  </picture>
</p>

> **Stable API.** From `0.1.0` the public API and upgrade path follow the [stability policy](https://good-webhooks.dev/docs/operations/compatibility#stability-policy). Throughput beyond the [measured profile](https://good-webhooks.dev/docs/operations/performance) is not yet verified.

## Features

- **Typed events.** Any [Standard Schema](https://standardschema.dev) validator. Bad payloads are rejected on publish, and receivers decode into the same types.
- **Standard Webhooks signing.** Every request carries `webhook-id`, `webhook-timestamp`, and an HMAC-SHA256 signature, so any compliant verifier works.
- **Transactional publish.** Pass your open PostgreSQL client. If your write rolls back, the event never existed.
- **Retries and replay.** A bounded retry schedule, every attempt recorded, and replay without changing the event ID.
- **Better Auth plugin.** Signed-in users manage their own endpoints through authenticated routes.
- **Nothing implicit.** No connections, migrations, or workers start on their own. You own the pool and the process.

## Install

```sh
npm install good-webhooks pg zod
```

```sh
pnpm add good-webhooks pg zod
```

```sh
yarn add good-webhooks pg zod
```

<details>
<summary>Using Better Auth for endpoint management</summary>

The plugin uses your existing Better Auth database adapter. PostgreSQL is only needed for built-in delivery.

```sh
npm install good-webhooks better-auth@1.7.10
```

Then follow the [Better Auth quick start](https://good-webhooks.dev/docs/better-auth/quick-start).

</details>

## Usage

**1. Create the tables.** Apply the SQL from `getPostgresMigration()`, exported by `good-webhooks/migrations`, once with your migration tool.

**2. Create the client.**

```ts
import { createWebhooks } from 'good-webhooks'
import { Pool } from 'pg'
import { z } from 'zod'

const events = {
  'invoice.paid': z.object({
    invoiceId: z.string(),
    amount: z.number().int(),
  }),
}

const webhooks = createWebhooks({
  database: new Pool({
    connectionString: process.env.DATABASE_URL,
  }),
  // Created once by generateEncryptionKey().
  encryptionKey: process.env.WEBHOOK_ENCRYPTION_KEY!,
  events,
})
```

**3. Register an endpoint and publish.**

```ts
// The signing secret is returned only once.
const { secret } = await webhooks.endpoints.create({
  url: 'https://receiver.example/webhooks',
  eventTypes: ['invoice.paid'],
})

// Add { transaction: client } as a second argument
// to publish inside your own transaction.
await webhooks.publish({
  type: 'invoice.paid',
  data: { invoiceId: 'inv_123', amount: 4200 },
  idempotencyKey: 'invoice.paid:inv_123',
})
```

**4. Run a worker** in a separate process.

```ts
const stop = new AbortController()
process.once('SIGTERM', () => stop.abort())

await webhooks.worker.run({ signal: stop.signal })
```

**5. Verify on the receiving side.**

```ts
import { parseWebhook } from 'good-webhooks/verify'

const event = await parseWebhook({
  body: rawBody, // the unparsed request body
  headers: request.headers,
  secret, // the endpoint's signing secret
  events, // the same event schemas
})
```

## Setups

| You want                                     | Start with                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| Everything on PostgreSQL                     | [Quick start](https://good-webhooks.dev/docs/quick-start)              |
| Signed-in users managing their own endpoints | [Better Auth plugin](https://good-webhooks.dev/docs/better-auth)       |
| Better Auth endpoints with built-in delivery | [Add delivery](https://good-webhooks.dev/docs/better-auth/delivery)    |
| Endpoint management for your own sender      | [Custom senders](https://good-webhooks.dev/docs/guides/custom-senders) |
| Only receiving webhooks                      | [Receive webhooks](https://good-webhooks.dev/docs/guides/receive)      |

## Requirements

| Dependency  | Supported                                                                   |
| ----------- | --------------------------------------------------------------------------- |
| Node.js     | 24 or later                                                                 |
| PostgreSQL  | 16, 17, or 18, for built-in delivery and standalone management              |
| TypeScript  | 5.9.3 or later, with `NodeNext` or `Bundler` resolution                     |
| Better Auth | 1.7.7 or later 1.7, and 1.8 including 1.8.0 betas; optional peer dependency |
| Validators  | Any [Standard Schema](https://standardschema.dev) library, such as Zod      |

## Guarantees

Delivery is at least once, with no ordering. Receivers must verify signatures and record each event ID with their change. See [delivery guarantees](https://good-webhooks.dev/docs/concepts/delivery-guarantees).

## For AI agents

This package ships an [Agent Skill](https://agentskills.io) in `skills/good-webhooks/` that matches the installed version. Docs for agents are at [llms.txt](https://good-webhooks.dev/llms.txt).

## License

MIT. See the [contribution guide](https://github.com/pplytas/good-webhooks/blob/main/CONTRIBUTING.md) and [security policy](https://github.com/pplytas/good-webhooks/blob/main/SECURITY.md).
