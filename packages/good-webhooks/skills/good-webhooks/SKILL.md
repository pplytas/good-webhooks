---
name: good-webhooks
description: Add outbound webhooks to a Node.js TypeScript app with the good-webhooks library, or receive them. Use when publishing webhook events, running the delivery worker, managing webhook endpoints or signing secrets, verifying incoming webhooks with parseWebhook, or wiring the Better Auth goodWebhooks plugin.
license: MIT
---

# Good Webhooks

`good-webhooks` stores published events in the app's PostgreSQL database, delivers signed Standard Webhooks requests from a worker the app runs, retries failures, and keeps attempt history. Receivers verify with `parseWebhook()`.

This skill ships inside the npm package, so it matches the installed version. Full docs as Markdown: https://good-webhooks.vercel.app/llms.txt (append `.md` to any docs URL). Checked examples ship in `node_modules/good-webhooks/examples/`.

## Rules

Follow these. They are the mistakes agents make most often with this library.

1. `publish()` only stores the event. Nothing is sent unless a worker calls `worker.run({ signal })` (long-running) or `worker.runOnce()` (one batch).
2. Load the storage encryption key from configuration (`WEBHOOK_ENCRYPTION_KEY`). Generate it once with `generateEncryptionKey()` and store it. Never generate it at startup: existing endpoints become unreadable.
3. Never apply migrations at runtime. Write `getPostgresMigration()` output to a migration file and apply it with the project's migration tool. Call `check()` at startup.
4. Receivers pass the raw body (string or `Uint8Array`) to `parseWebhook()`, never parsed JSON. In Express use `express.raw({ type: 'application/json', limit: '512kb' })` on the route.
5. Delivery is at least once with no ordering. Receivers insert `event.id` into a table with a unique key in the same transaction as their change, and respond `2xx` for repeats.
6. Receivers respond `400` only for `WebhookError` codes `SIGNATURE_INVALID`, `SIGNATURE_EXPIRED`, `PAYLOAD_INVALID`. Everything else is `500`, so the sender retries.
7. `forScope(scope)` does not authorize. Check that the caller may act for that customer first. Never take a scope ID from a request body unchecked.
8. When the business write uses the same database, publish inside it: `publish(input, { transaction: client })` with a checked-out client, not the pool.
9. Give every `publish()` that can repeat an `idempotencyKey` derived from the business fact, such as `invoice.paid:${invoiceId}`.
10. `allowLocalhost: true` is for local development only.
11. Signing secrets (`whsec_…`) are returned once by `create()` and `rotateSecret()`. Never log them.

## Setup (standalone PostgreSQL)

```sh
npm install good-webhooks@alpha pg zod
node -e 'import("good-webhooks").then(m => console.log(m.generateEncryptionKey()))'   # store as WEBHOOK_ENCRYPTION_KEY
node -e 'import("good-webhooks/migrations").then(m => process.stdout.write(m.getPostgresMigration()))' > 001-webhooks.sql
```

```ts
// webhooks.ts
import { createWebhooks } from 'good-webhooks'
import { Pool } from 'pg'
import { events } from './events.js'

export const pool = new Pool({ connectionString: process.env.DATABASE_URL })
export const webhooks = createWebhooks({
  database: pool,
  encryptionKey: process.env.WEBHOOK_ENCRYPTION_KEY!,
  events,
})
```

```ts
// events.ts: shared by the producer and receivers. Any Standard Schema validator.
import { z } from 'zod'

export const events = {
  'invoice.paid': z.object({ invoiceId: z.string(), amount: z.number().int().nonnegative() }),
}
```

## Publish in a transaction

```ts
import { pool, webhooks } from './webhooks.js'

const client = await pool.connect()
try {
  await client.query('BEGIN')
  await client.query('UPDATE invoices SET paid = true WHERE id = $1', [invoiceId])
  await webhooks.forScope({ type: 'organization', id: organizationId }).publish(
    {
      type: 'invoice.paid',
      data: { invoiceId, amount },
      idempotencyKey: `invoice.paid:${invoiceId}`,
    },
    { transaction: client },
  )
  await client.query('COMMIT')
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  client.release()
}
```

## Worker process

```ts
// worker.ts: run as its own process
import { pool, webhooks } from './webhooks.js'

const stop = new AbortController()
process.once('SIGTERM', () => stop.abort())
process.once('SIGINT', () => stop.abort())

await webhooks.check()
await webhooks.worker.run({ signal: stop.signal })
await pool.end()
```

Schedule `webhooks.worker.prune()` in a loop until it returns `0` from a cleanup job; workers never delete history.

## Endpoints

```ts
const customer = webhooks.forScope({ type: 'organization', id: organizationId })
const { endpoint, secret } = await customer.endpoints.create({
  url: 'https://receiver.example/webhooks',
  eventTypes: ['invoice.paid'],
})
// update(id, patch) · pause(id) · resume(id) · rotateSecret(id, { graceMs }) · remove(id)
```

## Receiver (Web Request, for example Next.js route handlers)

```ts
import { parseWebhook, WebhookError } from 'good-webhooks/verify'
import { events } from './events.js'

export async function POST(request: Request) {
  if (Number(request.headers.get('content-length')) > 512 * 1024) {
    return new Response('Webhook body is too large', { status: 413 })
  }
  try {
    const event = await parseWebhook({
      body: new Uint8Array(await request.arrayBuffer()),
      headers: request.headers,
      secret: process.env.WEBHOOK_SECRET!, // an array during a rotation
      events,
    })
    // In one transaction: INSERT event.id into a receipts table (ON CONFLICT DO NOTHING),
    // and apply the change only if the insert added a row.
    return new Response(null, { status: 204 })
  } catch (error) {
    if (
      error instanceof WebhookError &&
      ['SIGNATURE_INVALID', 'SIGNATURE_EXPIRED', 'PAYLOAD_INVALID'].includes(error.code)
    ) {
      return new Response('Invalid webhook', { status: 400 })
    }
    throw error
  }
}
```

## Better Auth

Server: `goodWebhooks({ eventTypes })` from `good-webhooks/better-auth` in `betterAuth({ plugins })`, with `eventTypes` an `as const` tuple in its own module. Client: `goodWebhooksClient({ eventTypes })` from `good-webhooks/better-auth/client`. Generate the schema with the Better Auth CLI; never apply `management.sql` for the plugin. To deliver, build `createDelivery({ database, events, source: (await createBetterAuthManagement(auth)).source })` from `good-webhooks/delivery`, and publish in the owner's scope (`{ type: 'user', id }`). Organization scopes need the `webhookEndpoint` permission in the organization plugin's access control.

## Where to read more

| Task                            | Page                                                                  |
| ------------------------------- | --------------------------------------------------------------------- |
| First run end to end            | https://good-webhooks.vercel.app/docs/quick-start.md                  |
| Add to an existing app          | https://good-webhooks.vercel.app/docs/installation.md                 |
| Publishing, idempotency, scopes | https://good-webhooks.vercel.app/docs/guides/publish.md               |
| Receivers for each framework    | https://good-webhooks.vercel.app/docs/guides/receive.md               |
| Workers and shutdown            | https://good-webhooks.vercel.app/docs/operations/workers.md           |
| Better Auth plugin              | https://good-webhooks.vercel.app/docs/better-auth.md                  |
| Guarantees and retry schedule   | https://good-webhooks.vercel.app/docs/concepts/delivery-guarantees.md |
| Launch checklist                | https://good-webhooks.vercel.app/docs/operations/production.md        |
