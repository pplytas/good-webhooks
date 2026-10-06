# Webhook Dispatch

Build webhook delivery into your TypeScript application.

An embedded TypeScript package for outbound webhooks. Your application publishes typed events to PostgreSQL. An explicit worker delivers signed HTTP requests, records attempts, and retries failures.

This is an unpublished v0 package. It requires Node.js 24 or later and PostgreSQL 16 or later.

The package ships ESM. On Node.js 24+, both `import` and CommonJS `require()` load the same build.

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
psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f migrations/001-initial.sql
psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f examples/basic/receiver.sql
node examples/basic/demo.ts
```

Apply each SQL file once. The second file creates the demo application's receipt and invoice tables for durable deduplication. The example does not create or reset the schema. Each run uses the application scope, publishes a unique invoice, and removes its endpoint on exit. It leaves event, attempt, and receiver history for inspection.

Expected output includes a rollback with no delivery, a successful delivery after two attempts, and a successful replay. The receiver applies the event once despite repeated requests.

## Install a local build

Build the package archive from this checkout:

```sh
npm pack
```

Install that archive in your application:

```sh
npm install /absolute/path/to/webhook-dispatch-0.0.0.tgz pg zod
npm install --save-dev @types/pg
```

`pg` and Zod belong to your application. You supply the PostgreSQL pool. Event definitions accept [Standard Schema](https://standardschema.dev/) validators, including Zod.

## Configure the server

Generate an encryption key once, then store it in your secret manager:

```sh
node --input-type=module -e 'import { generateEncryptionKey } from "webhook-dispatch"; console.log(generateEncryptionKey())'
```

Keep the same key across application and worker instances. Replacing it makes existing endpoint secrets unreadable. Automated encryption-key rotation is outside v0.

Keep event schemas in a module that both the producer and receiver can import:

```ts
// events.ts
import { z } from 'zod'

export const events = {
  'invoice.paid': z.object({
    invoiceId: z.string(),
    amount: z.number().int().nonnegative(),
  }),
}
```

Configure the producer with that map:

```ts
import { createWebhooks } from 'webhook-dispatch'
import { Pool } from 'pg'
import { events } from './events.js'

export const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export const webhooks = createWebhooks({
  database: pool,
  encryptionKey: process.env.WEBHOOK_ENCRYPTION_KEY!,
  events,
})

await webhooks.check()
```

Construction starts no background work and applies no DDL. `check()` checks the schema version. Your migration runner owns schema changes.

For an installed package, resolve its SQL migration through the exported path:

```sh
node --input-type=module -e 'import { readFile } from "node:fs/promises"; process.stdout.write(await readFile(new URL(import.meta.resolve("webhook-dispatch/migrations/001-initial.sql")), "utf8"))' > 001-webhooks.sql
psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f 001-webhooks.sql
```

Review and apply the migration once before calling `check()`. It creates the `webhooks` schema in the database you supply.

The SQL contains no `BEGIN` or `COMMIT`. Your migration runner must execute it and its migration bookkeeping in one transaction on the same connection. For standalone setup, the `psql` command above supplies that transaction and rolls back on failure. The application's migration ledger tracks execution order; `webhooks.schema_version` records schema compatibility.

This unpublished revision uses schema version 2. The earlier tenant-based prototype used version 1 and is incompatible. This migration initializes a fresh database; it does not upgrade existing prototype data. `check()` rejects that older schema. No schema or data changes happen automatically.

## Register a receiver and publish

Use the configured instance directly for application-wide webhooks. No user, organization, or tenant setup is required. Your application authenticates and authorizes any caller allowed to manage these endpoints.

```ts
const { endpoint, secret } = await webhooks.endpoints.create({
  url: 'https://receiver.example.com/webhooks',
  eventTypes: ['invoice.paid'],
})

// Deliver this secret to the authorized receiver through your own secure channel.
// Normal endpoint reads do not return secrets.

const publication = await webhooks.publish({
  type: 'invoice.paid',
  data: { invoiceId: 'inv_123', amount: 4200 },
  idempotencyKey: 'invoice-paid:inv_123',
})
```

The event map infers event names and input payloads. Each publication also validates its data at runtime. Validated output must contain JSON values, fit within 256 KiB, and have a maximum depth of 64.

`publish()` accepts the event durably and creates deliveries for matching, nondeleted endpoints. A paused endpoint still receives queued deliveries. `deliveryCount` can be zero. Acceptance does not mean that a receiver has accepted a request.

The same scope, idempotency key, event type, and validated payload return the existing event with `duplicate: true`. Reusing the key with different content throws `IDEMPOTENCY_CONFLICT`. Keys remain reserved while their events remain in the database.

To publish atomically with a business change, pass a PostgreSQL client inside an active transaction:

```ts
const client = await pool.connect()
try {
  await client.query('BEGIN')
  await client.query('UPDATE invoices SET paid = true WHERE id = $1', ['inv_123'])
  await webhooks.publish(
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

## Isolate endpoints for different owners

Applications with personal, organization, workspace, or other owner-specific webhooks can select a named scope:

```ts
// The application has already authenticated the caller and authorized each selection.
const personal = webhooks.forScope({ type: 'user', id: user.id })
const organization = webhooks.forScope({ type: 'organization', id: organizationId })

await organization.endpoints.create({
  url: 'https://receiver.example.com/organization-webhooks',
  eventTypes: ['invoice.paid'],
})
await organization.publish({
  type: 'invoice.paid',
  data: { invoiceId: 'inv_456', amount: 4200 },
  idempotencyKey: 'invoice-paid:inv_456',
})
await personal.endpoints.list()
```

`type` and `id` are application-defined strings. A user and an organization with the same ID have separate endpoints, events, idempotency keys, and delivery history. `type` accepts 1–64 characters; `id` accepts 1–200. Both must be nonblank and contain no null bytes. Values retain their exact spelling and case.

Root operations select only the application scope. They never list or publish across named scopes. Named publications never fall back to application endpoints, even if they have no matching endpoints of their own. The application scope belongs to the configured database and schema, so separate factory instances using that schema share it.

`forScope()` validates and snapshots the selection immediately. It creates no identity record, starts no I/O, and never changes another client's scope. Invalid or missing selections throw `INVALID_INPUT`; they cannot select the application scope. A bound client exposes only `endpoints`, `publish`, and `deliveries`.

Choose and authorize scopes in your application, then pass bound clients into request handlers. Do not pass unchecked request-body identifiers to `forScope()`. The library does not manage users, organizations, membership, or permissions. Management results and signed event envelopes contain no internal scope keys.

## Run deliveries and retain history

Call `tick()` to process one batch, or await `run()` with an abort signal:

```ts
await webhooks.worker.tick()
// Or, in a long-running process:
const stop = new AbortController()
await webhooks.worker.run({ signal: stop.signal, pollIntervalMs: 1000 })
```

Use the [runnable worker and cleanup entry points](docs/operations.md) for complete process setup, signal handling, database timeouts, failure reporting, pool closure, and cleanup scheduling.

Workers and pruning operate across every scope in the configured database. These maintenance operations are available only on the root instance. Each worker claims work through PostgreSQL leases. Multiple processes can share the database. A worker holds no database transaction open during HTTP requests. Shutdown aborts active requests, whose receiver outcomes may be unknown.

Without `onError`, an unexpected worker error rejects `run()`. With `onError`, the worker reports the error and continues polling. Receiver failures appear in delivery records.

Set `pollIntervalMs` on `worker.run()` only. It defaults to 1,000 ms and accepts integers from 10 to 60,000 ms. `tick()` processes one batch without polling.

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

History cleanup is explicit. Each `worker.prune()` call deletes at most 100 expired events with their deliveries and attempts. Use the [bounded cleanup recipe](docs/operations.md#schedule-bounded-cleanup-runs) to schedule enough deletion capacity. Unexpired worker leases defer deletion. A zero result does not prove that no expired records remain. Neither `tick()` nor `run()` prunes history automatically.

## Manage endpoints and deliveries

These operations use the application scope. A client returned by `forScope()` exposes the same methods within its selected scope:

```ts
await webhooks.endpoints.list()
await webhooks.endpoints.get(endpoint.id)
await webhooks.endpoints.update(endpoint.id, { maxInFlight: 4 })
await webhooks.endpoints.pause(endpoint.id)
await webhooks.endpoints.resume(endpoint.id)

const rotated = await webhooks.endpoints.rotateSecret(endpoint.id, { graceMs: 3_600_000 })
// Give rotated.secret to the receiver before the overlap expires.

const page = await webhooks.deliveries.list({ eventId: publication.eventId, limit: 25 })
const delivery = page.items[0]
if (delivery) {
  const detail = await webhooks.deliveries.get(delivery.id)
  console.log(detail.status, detail.attempts)
  if (detail.replayOf === null && ['succeeded', 'failed'].includes(detail.status)) {
    await webhooks.deliveries.replay(detail.id)
  }
}

await webhooks.endpoints.remove(endpoint.id)
```

Pausing stops new claims. It does not recall an HTTP request already in flight. Deletion cancels outstanding deliveries but cannot undo a request a receiver has already received.

Signing-secret rotation accepts an overlap of zero to 24 hours and defaults to 24 hours. During overlap, new requests include signatures for both keys. Another overlapping rotation is rejected until the previous overlap expires.

A replay creates a new delivery for an original `succeeded` or `failed` delivery. It requires an active endpoint and an event within the retention window. Only one pending or in-flight replay per original delivery is allowed. Replays use the endpoint's current URL and signing secret.

Endpoint lists include at most 1,000 nondeleted endpoints per scope, which is also the creation limit. Delivery lists use descending ID cursors. Pass `page.nextCursor` as `before` to fetch the next page. Delivery IDs are strings.

Filter delivery history by `eventId` from a publication, `endpointId`, or `status`. Filters can be combined. Delivery detail reads status and attempt history from one database snapshot.

Expected operation errors are `WebhookError` instances with a `code`, such as `NOT_FOUND`, `INVALID_INPUT`, `INVALID_STATE`, `IDEMPOTENCY_CONFLICT`, or `REPLAY_IN_PROGRESS`. Infrastructure failures may be ordinary errors. Treat response history as sensitive application data.

## Receive typed events

The package implements the [Standard Webhooks symmetric signing format](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) with Node.js crypto. It does not depend on the `standardwebhooks` npm package or Better Auth.

```ts
import { parseWebhook } from 'webhook-dispatch/verify'
import { events } from './events.js'

// Read the original bytes through your framework's bounded body reader.
const event = await parseWebhook({ body: rawBody, headers: request.headers, secret, events })
if (event.type === 'invoice.paid') {
  event.data.invoiceId // string
  event.data.amount // number
}
```

`parseWebhook()` verifies the original bytes, matches the signed ID to the envelope, validates the payload, and returns a discriminated union of your schemas' output types. `ParsedWebhook<typeof events>` exports that inferred result type. The parser accepts secret rotation and timestamp settings.

The envelope contains `id`, `type`, `occurredAt`, and `data`. Share value-preserving schemas between producer and receiver. Normalize domain inputs before publication or use a separate receiver map for transforming producer schemas.

The [receiver guide](docs/receiving.md) covers request limits, durable deduplication, schema evolution, errors, and the workaround for asynchronous Zod schemas. Unexpected server failures must return `5xx` so the sender can retry.

`verifyWebhook()` remains available for signature-only verification of other payload formats. The default timestamp tolerance is five minutes. Neither function deduplicates events or authorizes a scope.

## Scope and security

The package provides server operations, PostgreSQL persistence, signing, delivery, retries, and replay. Authentication, permissions, HTTP management routes, dashboards, and worker hosting belong to your application. v0 includes no framework plugin, browser client, or alternative database adapter.

Endpoint URLs must use HTTPS and resolve to public addresses. Registration and every delivery validate the destination. Connections use the validated IP address and preserve TLS hostname checks. Private destinations, embedded credentials, and redirects are blocked. `allowLocalhost: true` permits loopback HTTP for development, not arbitrary private networks.

Endpoint secrets use AES-256-GCM encryption at rest. Store the encryption key outside PostgreSQL. Access to the database still exposes event payloads and response history.

The [Better Auth integration sketch](docs/better-auth-integration.md) describes a possible later adapter. The delivery core requires no auth instance or Better Auth identity types.
