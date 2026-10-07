# Good Webhooks

Build webhook delivery into your TypeScript application.

[![CI](https://github.com/pplytas/good-webhooks/actions/workflows/ci.yml/badge.svg)](https://github.com/pplytas/good-webhooks/actions/workflows/ci.yml)

An embedded TypeScript package for outbound webhooks. Use the Better Auth plugin for authenticated endpoint management with your existing database, bring your own sender, or add our PostgreSQL publisher and worker.

| Setup                                  | Entry points                                                    | Storage                                              |
| -------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| Better Auth management with any sender | `good-webhooks/better-auth`, `good-webhooks/better-auth/client` | One management model through BA's adapter            |
| Better Auth management with our sender | Above plus `good-webhooks/delivery`                             | BA database plus explicit PostgreSQL delivery tables |
| Standalone management and delivery     | `good-webhooks`                                                 | PostgreSQL management and delivery tables            |
| Standalone management with any sender  | `good-webhooks/management/postgres`                             | PostgreSQL management tables only                    |

See the [Better Auth guide](docs/better-auth.md), [management contract](docs/management.md), and [database compatibility checks](docs/better-auth-database-compatibility.md). The standalone walkthrough follows.

This is an unpublished v0 package. Our delivery engine and standalone PostgreSQL provider require Node.js 24 or later and PostgreSQL 16 or later. The Better Auth plugin uses the host adapter and does not require our delivery engine or PostgreSQL.

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
npm install /absolute/path/to/good-webhooks-0.0.0.tgz pg zod
npm install --save-dev @types/pg
```

`pg` and Zod belong to your application. You supply the PostgreSQL pool. Event definitions accept [Standard Schema](https://standardschema.dev/) validators, including Zod.

## Configure the server

Generate an encryption key once, then store it in your secret manager:

```sh
node --input-type=module -e 'import { generateEncryptionKey } from "good-webhooks"; console.log(generateEncryptionKey())'
```

Keep compatible keys across application and worker instances. For storage-key rotation, construct a standalone management provider with retained `decryptionKeys`, run `reencrypt(scope)` for every scope, then retire the old keys. See [key rotation](docs/management.md).

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
import { createWebhooks } from 'good-webhooks'
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

Construction starts no background work and applies no DDL. `check()` verifies the management schema and delivery schema version. Your migration runner owns schema changes. PostgreSQL tables use the `webhook_` prefix in `public` by default.

Generate the initial SQL from an installed package, then apply it through your migration runner:

```sh
node --input-type=module -e 'import { getPostgresMigration } from "good-webhooks/migrations"; process.stdout.write(getPostgresMigration())' > 001-webhooks.sql
psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f 001-webhooks.sql
```

Review and apply the migration once before calling `check()`. It creates `public.webhook_endpoints` for standalone management and `public.webhook_endpoint_state`, `public.webhook_events`, `public.webhook_deliveries`, `public.webhook_attempts`, and `public.webhook_schema_version` for delivery.

`getPostgresMigration({ component: 'management' })` or `{ component: 'delivery' }` returns only that component's SQL. The default is `component: 'all'`. The shipped `001-initial.sql`, `management.sql`, and `delivery.sql` files contain the same SQL for `public`. BA management uses BA's schema workflow instead of the standalone management migration. Do not apply the combined and separate migrations to the same installation.

For a custom PostgreSQL schema, share one constant between your migration configuration and runtime:

```ts
import { getPostgresMigration } from 'good-webhooks/migrations'

// webhook-schema.ts
export const webhookSchema = 'notifications'

// Migration configuration: save this SQL or pass it to your migration runner.
const sql = getPostgresMigration({ schema: webhookSchema })

// Application and worker configuration:
const webhooks = createWebhooks({
  database: pool,
  schema: webhookSchema,
  encryptionKey: process.env.WEBHOOK_ENCRYPTION_KEY!,
  events,
})
```

`getPostgresMigration` only returns SQL. `createWebhooks({ schema })` uses that schema for its built-in management provider and delivery tables. To separate them, inject a management provider configured with its own schema or database; see the [management guide](docs/management.md#separate-postgresql-schemas).

The SQL contains no `BEGIN` or `COMMIT`. Your migration runner must execute it and its migration bookkeeping in one transaction on the same connection. For standalone setup, the `psql` command above supplies that transaction and rolls back on failure. The application's migration ledger tracks execution order; `webhook_schema_version` in the selected schema records delivery compatibility.

This unpublished revision uses delivery schema version 3. Earlier prototype schemas are incompatible. This migration initializes a fresh database; it does not upgrade existing prototype data. `check()` rejects that older schema. No schema or data changes happen automatically.

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

`publish()` obtains a complete recipient list through the configured provider, then atomically stores the event and its deliveries in PostgreSQL. Concurrent endpoint edits can produce a mixed view; unchanged matching endpoints remain included. Accepted idempotent publications retain their original recipients. A paused endpoint still receives queued deliveries. `deliveryCount` can be zero. Acceptance does not mean that a receiver has accepted a request.

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

The client must use the configured delivery database and schema. Endpoint lookup through the management provider remains outside that transaction; this does not create a distributed transaction. Do not run concurrent operations on that client. The caller owns commit and rollback. Until commit, the returned publication is provisional and invisible to workers.

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

`forScope()` validates and snapshots the selection immediately. It creates no identity record, starts no I/O, and never changes another client's scope. Invalid or missing selections throw `INVALID_INPUT`; they cannot select the application scope. A bound client exposes `endpoints`, `publish`, `deliveries`, and `deliverySettings`.

Choose and authorize scopes in your application, then pass bound clients into request handlers. Do not pass unchecked request-body identifiers to `forScope()`. Standalone management does not manage users, organizations, membership, or permissions. The optional Better Auth plugin supplies session authentication and ownership checks. Management results and signed event envelopes contain no internal scope keys.

## Run deliveries and retain history

Call `tick()` to process one batch, or await `run()` with an abort signal:

```ts
await webhooks.worker.tick()
// Or, in a long-running process:
const stop = new AbortController()
await webhooks.worker.run({ signal: stop.signal, pollIntervalMs: 1000 })
```

Use the [runnable worker and cleanup entry points](docs/operations.md) for complete process setup, signal handling, database timeouts, failure reporting, pool closure, and cleanup scheduling.

Workers and pruning operate across every scope in the configured delivery database and schema. These maintenance operations are available only on the root instance. Each worker claims work through PostgreSQL leases. Multiple processes can share the database. A worker holds no database transaction open during HTTP requests. Shutdown aborts active requests, whose receiver outcomes may be unknown.

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
await webhooks.deliverySettings.set(endpoint.id, { maxInFlight: 4 })
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

Pausing stops preparation of new requests while retaining existing and newly published work within normal expiry limits. Deletion makes an endpoint ineligible immediately; our worker cancels pending work when it observes that state. A request already prepared can still arrive. Management never waits for the sender to clean up its queue. Provider failures defer sending without consuming a receiver attempt and are reported to the worker host. Endpoint lookups have half the configured worker lease as their time budget. Paused or unavailable endpoints are deferred for one second.

Signing-secret rotation accepts an overlap of zero to 24 hours and defaults to 24 hours. During overlap, new requests include signatures for both keys. Another overlapping rotation is rejected until the previous overlap expires.

A replay creates a new delivery for an original `succeeded` or `failed` delivery. It requires an active endpoint and an event within the retention window. Only one pending or in-flight replay per original delivery is allowed. Replays use the endpoint's current URL and signing secret.

Endpoint lists include at most 1,000 nondeleted endpoints per scope, which is also the creation limit. Delivery lists use descending ID cursors. Pass `page.nextCursor` as `before` to fetch the next page. Delivery IDs are strings.

Filter delivery history by `eventId` from a publication, `endpointId`, or `status`. Filters can be combined. Delivery detail reads status and attempt history from one database snapshot.

Expected operation errors are `WebhookError` instances with a `code`, such as `NOT_FOUND`, `INVALID_INPUT`, `INVALID_STATE`, `IDEMPOTENCY_CONFLICT`, or `REPLAY_IN_PROGRESS`. Infrastructure failures may be ordinary errors. Treat response history as sensitive application data.

## Receive typed events

The package implements the [Standard Webhooks symmetric signing format](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) with Node.js crypto. It does not depend on the `standardwebhooks` npm package or Better Auth.

```ts
import { parseWebhook } from 'good-webhooks/verify'
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

The optional Better Auth plugin supplies authenticated management routes, client integration, user ownership, organization permissions, and custom-scope policies. Delivery settings, history, and replay remain trusted server operations. Dashboards and worker hosting belong to your application.

Endpoint URLs must use HTTPS and resolve to public addresses. Portable management checks URL syntax and literal IP addresses; standalone PostgreSQL management also checks DNS at registration. Our worker resolves and validates DNS before every delivery. Connections use the validated IP address and preserve TLS hostname checks. Private destinations, embedded credentials, and redirects are blocked. `allowLocalhost: true` permits loopback HTTP for development, not arbitrary private networks.

Standalone endpoint secrets use AES-256-GCM encryption at rest; BA management uses BA encryption helpers and its configured secrets. Keep encryption keys outside the database. Access to the database still exposes event payloads and response history.

The [design record](docs/better-auth-integration.md) explains the management and delivery boundary. The delivery core requires no auth instance or Better Auth identity types.

## Contribute

Read the [contribution guide](CONTRIBUTING.md) for local checks and pull requests. Report vulnerabilities through the [security policy](SECURITY.md).
