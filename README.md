# @pplytas/webhooks

An embedded TypeScript package for outbound webhooks. Your application publishes typed events to PostgreSQL. An explicit worker delivers signed HTTP requests, records attempts, and retries failures.

This is an unpublished v0 prototype. The package name is provisional. It requires Node.js 24 or later and PostgreSQL 16 or later.

## Try the example

The [runnable example](examples/basic/demo.ts) registers a local receiver, rolls back one publication, then delivers a committed event. The receiver returns `503` once, verifies every signature, and accepts the retry. The example then inspects attempts and replays the delivery.

Start a dedicated development database:

```sh
docker run --name webhooks-dev \
	-e POSTGRES_PASSWORD=webhooks_dev_only \
	-e POSTGRES_DB=webhooks \
	-p 127.0.0.1:55439:5432 \
	-d postgres:16
```

Wait for PostgreSQL to accept connections, then run these commands from the checkout:

```sh
npm install
npm run build
export DATABASE_URL='postgres://postgres:webhooks_dev_only@127.0.0.1:55439/webhooks'
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001-initial.sql
node examples/basic/demo.ts
```

Apply the migration once. The example does not create or reset the schema. Each run creates a new tenant and removes its endpoint on exit. It leaves event and attempt history for inspection.

Expected output includes a rollback with no delivery, a successful delivery after two attempts, and a successful replay. The receiver applies the event once despite repeated requests.

## Install a local build

Build the package archive from this checkout:

```sh
npm pack
```

Install that archive in your application:

```sh
npm install /absolute/path/to/pplytas-webhooks-0.0.0.tgz pg zod
npm install --save-dev @types/pg
```

`pg` and Zod belong to your application. You supply the PostgreSQL pool. Event definitions accept [Standard Schema](https://standardschema.dev/) validators, including Zod.

## Configure the server

Generate an encryption key once, then store it in your secret manager:

```sh
node --input-type=module -e 'import { generateEncryptionKey } from "@pplytas/webhooks"; console.log(generateEncryptionKey())'
```

Keep the same key across application and worker instances. Replacing it makes existing endpoint secrets unreadable. Automated encryption-key rotation is outside v0.

```ts
import { createWebhooks } from '@pplytas/webhooks'
import { Pool } from 'pg'
import { z } from 'zod'

export const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export const webhooks = createWebhooks({
  database: pool,
  encryptionKey: process.env.WEBHOOK_ENCRYPTION_KEY!,
  events: {
    'invoice.paid': z.object({
      invoiceId: z.string(),
      amount: z.number().int().nonnegative(),
    }),
  },
})

await webhooks.check()
```

Construction starts no background work and applies no DDL. `check()` checks the schema version. Your migration runner owns schema changes.

For an installed package, resolve its SQL migration through the exported path:

```sh
node --input-type=module -e 'import { readFile } from "node:fs/promises"; process.stdout.write(await readFile(new URL(import.meta.resolve("@pplytas/webhooks/migrations/001-initial.sql")), "utf8"))' > 001-webhooks.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 001-webhooks.sql
```

Review and apply the migration once before calling `check()`. It creates the `webhooks` schema in the database you supply.

## Register a receiver and publish

Your application authenticates the caller and checks permissions before choosing a tenant. Never pass an unchecked request-body tenant ID to `forTenant()`.

```ts
// Your application has already authorized this tenant.
const tenant = webhooks.forTenant({ id: 'account_123' })

const { endpoint, secret } = await tenant.endpoints.create({
  url: 'https://receiver.example.com/webhooks',
  eventTypes: ['invoice.paid'],
})

// Deliver this secret to the authorized receiver through your own secure channel.
// Normal endpoint reads do not return secrets.

const publication = await tenant.publish({
  type: 'invoice.paid',
  data: { invoiceId: 'inv_123', amount: 4200 },
  idempotencyKey: 'invoice-paid:inv_123',
})
```

The event map infers event names and input payloads. Each publication also validates its data at runtime. Validated output must contain JSON values, fit within 256 KiB, and have a maximum depth of 64.

`publish()` accepts the event durably and creates deliveries for matching, nondeleted endpoints. A paused endpoint still receives queued deliveries. `deliveryCount` can be zero. Acceptance does not mean that a receiver has accepted a request.

The same tenant, idempotency key, event type, and validated payload return the existing event with `duplicate: true`. Reusing the key with different content throws `IDEMPOTENCY_CONFLICT`. Keys remain reserved while their events remain in the database.

To publish atomically with a business change, pass a PostgreSQL client inside an active transaction:

```ts
const client = await pool.connect()
try {
  await client.query('BEGIN')
  await client.query('UPDATE invoices SET paid = true WHERE id = $1', ['inv_123'])
  await tenant.publish(
    {
      type: 'invoice.paid',
      data: { invoiceId: 'inv_123', amount: 4200 },
      idempotencyKey: 'invoice-paid:inv_123',
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

The client must use the configured database and schema. Do not run concurrent operations on that client. The caller owns commit and rollback. Until commit, the returned publication is provisional and invisible to workers.

## Run deliveries and retain history

Call `tick()` to process one batch, or run a worker until an abort signal stops it:

```ts
const stop = new AbortController()
process.once('SIGTERM', () => stop.abort())
process.once('SIGINT', () => stop.abort())

try {
  await webhooks.worker.run({
    signal: stop.signal,
    onError: (error) => console.error('Webhook worker failed:', error),
  })
} finally {
  await pool.end()
}
```

Each worker claims work through PostgreSQL leases. Multiple processes can share the database. A worker holds no database transaction open during HTTP requests. Shutdown aborts active requests, whose receiver outcomes may be unknown.

Without `onError`, an unexpected worker error rejects `run()`. With `onError`, the worker reports the error and continues polling. Receiver failures appear in delivery records.

Delivery is bounded and may occur more than once. There is no exactly-once or ordering guarantee. Receivers must deduplicate `webhook-id`. Retries and manual replays preserve the event ID and body.

Defaults are:

| Setting                          | Default                                                    |
| -------------------------------- | ---------------------------------------------------------- |
| Retry delays                     | 1s, 5s, 30s, 2m, 10m, 30m, each with 0 to 20% added jitter |
| Maximum attempts                 | 7, including the first request                             |
| Maximum delivery age             | 24 hours                                                   |
| Request timeout                  | 10 seconds                                                 |
| Claim lease                      | 60 seconds                                                 |
| Concurrent requests per worker   | 10                                                         |
| Concurrent requests per endpoint | 2, shared across workers                                   |
| Poll interval                    | 1 second                                                   |
| Stored response body             | First 4 KiB per attempt                                    |
| Event retention window           | 7 days                                                     |

The worker retries network failures, `408`, `425`, `429`, and `5xx` responses within its attempt and age limits. A `2xx` response succeeds. Other responses fail without a retry. Redirects are never followed.

History cleanup is explicit. Schedule `await webhooks.worker.prune()` from your application. Each call deletes at most 100 expired events with their deliveries and attempts. Active claims defer deletion. Neither `tick()` nor `run()` prunes history automatically.

## Manage endpoints and deliveries

All operations below use the trusted tenant scope:

```ts
await tenant.endpoints.list()
await tenant.endpoints.get(endpoint.id)
await tenant.endpoints.update(endpoint.id, { maxInFlight: 4 })
await tenant.endpoints.pause(endpoint.id)
await tenant.endpoints.resume(endpoint.id)

const rotated = await tenant.endpoints.rotateSecret(endpoint.id, { graceMs: 3_600_000 })
// Give rotated.secret to the receiver before the overlap expires.

const page = await tenant.deliveries.list({ endpointId: endpoint.id, limit: 25 })
const delivery = page.items[0]
if (delivery) {
  const detail = await tenant.deliveries.get(delivery.id)
  console.log(detail.status, detail.attempts)
  if (detail.replayOf === null && ['succeeded', 'failed'].includes(detail.status)) {
    await tenant.deliveries.replay(detail.id)
  }
}

await tenant.endpoints.remove(endpoint.id)
```

Pausing stops new claims. It does not recall an HTTP request already in flight. Deletion cancels outstanding deliveries but cannot undo a request a receiver has already received.

Signing-secret rotation accepts an overlap of zero to 24 hours and defaults to 24 hours. During overlap, new requests include signatures for both keys. Another overlapping rotation is rejected until the previous overlap expires.

A replay creates a new delivery for an original `succeeded` or `failed` delivery. It requires an active endpoint and an event within the retention window. Only one pending or in-flight replay per original delivery is allowed. Replays use the endpoint's current URL and signing secret.

Endpoint lists include at most 1,000 nondeleted endpoints per tenant, which is also the creation limit. Delivery lists use descending ID cursors. Pass `page.nextCursor` as `before` to fetch the next page. Delivery IDs are strings.

Expected operation errors are `WebhookError` instances with a `code`, such as `NOT_FOUND`, `INVALID_INPUT`, `INVALID_STATE`, `IDEMPOTENCY_CONFLICT`, or `REPLAY_IN_PROGRESS`. Infrastructure failures may be ordinary errors. Treat tenant-owned response history as sensitive application data.

## Verify incoming requests

The package implements the [Standard Webhooks symmetric signing format](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) with Node.js crypto. It does not depend on the `standardwebhooks` npm package or Better Auth.

```ts
import { verifyWebhook } from '@pplytas/webhooks/verify'

// Preserve the exact bytes before parsing JSON.
const body = await request.text()
verifyWebhook({ body, headers: request.headers, secret })
const event = JSON.parse(body)
```

`verifyWebhook()` returns normally on success and throws on failure. It checks `webhook-id`, `webhook-timestamp`, and `webhook-signature`, with a default timestamp tolerance of five minutes. It does not deduplicate events or validate the parsed payload.

The JSON envelope contains `id`, `type`, `occurredAt`, and `data`. `occurredAt` records publication time. The signed header ID matches the envelope's event ID.

## Scope and security

The package provides server operations, PostgreSQL persistence, signing, delivery, retries, and replay. Authentication, permissions, HTTP management routes, dashboards, and worker hosting belong to your application. v0 includes no framework plugin, browser client, or alternative database adapter.

Endpoint URLs must use HTTPS and resolve to public addresses. Registration and every delivery validate the destination. Connections use the validated IP address and preserve TLS hostname checks. Private destinations, embedded credentials, and redirects are blocked. `allowLocalhost: true` permits loopback HTTP for development, not arbitrary private networks.

Endpoint secrets use AES-256-GCM encryption at rest. Store the encryption key outside PostgreSQL. Access to the database still exposes event payloads and response history.

The [Better Auth integration sketch](docs/better-auth-integration.md) describes a possible later adapter. The delivery core requires no auth instance or Better Auth identity types.
