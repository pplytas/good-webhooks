# Endpoint management

Use endpoint management independently of Good Webhooks publication and delivery. It stores destinations, subscriptions, ownership, lifecycle state, and encrypted signing secrets. It creates no events, deliveries, or attempts.

For authenticated HTTP management using your application's existing database, use the [Better Auth plugin](better-auth.md). For standalone PostgreSQL management, use `createPostgresManagement`.

## Standalone PostgreSQL setup

Apply `good-webhooks/migrations/management.sql` to a PostgreSQL 16+ database using your migration runner. Then create the provider:

```ts
import { Pool } from 'pg'
import { createPostgresManagement } from 'good-webhooks/management/postgres'

const database = new Pool({ connectionString: process.env.MANAGEMENT_DATABASE_URL })
const management = createPostgresManagement({
  database,
  eventTypes: ['invoice.created', 'invoice.paid'],
  encryptionKey: process.env.WEBHOOK_ENCRYPTION_KEY!,
})

await management.check()
```

Supply a base64-encoded 32-byte storage encryption key or a `Uint8Array` containing 32 bytes. Keep it outside the database. `generateEncryptionKey()` from `good-webhooks` can generate a key during setup; persist it instead of generating one each time the app starts.

The provider uses only `webhooks_management.endpoints`. `check()` reads the expected columns; it does not install or migrate them. The host owns database connections and closes its pool on shutdown.

## Operations and scopes

Every direct management operation accepts a scope as its first argument. Use `null` for application scope or `{ type, id }` for a named scope. Scope selection is a trusted server capability. Authorize the caller before exposing it through your own API.

```ts
const scope = { type: 'organization', id: organizationId }
const created = await management.create(scope, {
  url: 'https://receiver.example/webhooks',
  description: 'Invoice notifications',
  eventTypes: ['invoice.created'],
})

// Transfer this value securely to the receiver. Ordinary reads do not return it.
const signingSecret = created.secret
await management.pause(scope, created.endpoint.id)
await management.resume(scope, created.endpoint.id)
```

| Method                                   | Result                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `create(scope, input)`                   | `{ endpoint, secret }`                                                   |
| `list(scope)`                            | All nondeleted endpoints in that scope                                   |
| `get(scope, id)`                         | One endpoint, including its deleted state                                |
| `update(scope, id, patch)`               | Endpoint with the supplied URL, description, or subscriptions changed    |
| `pause(scope, id)` / `resume(scope, id)` | Endpoint with its new state                                              |
| `remove(scope, id)`                      | Permanently deleted endpoint; stored signing secrets are cleared         |
| `rotateSecret(scope, id, { graceMs? })`  | `{ endpoint, secret }` with a newly generated signing secret             |
| `removeScope(scope)`                     | Retires the scope's currently registered endpoints                       |
| `reencrypt(scope)`                       | Count of live records rewritten under the current storage encryption key |

Each scope allows at most 1,000 nondeleted endpoints. Each endpoint subscribes to 1–100 configured event names. Management requires event names only. Payload validators belong to publication.

Endpoint IDs are opaque strings. Different scope types with the same identifier remain separate. Ordinary endpoint results contain URL, description, subscriptions, status, and timestamps, without encrypted or plaintext signing secrets.

## Supplying your own sender

Give a sender `management.source`, which exposes two trusted read operations:

```ts
const endpointIds = await management.source.matchRecipients(scope, 'invoice.created')
for (const id of endpointIds) {
  const endpoint = await management.source.resolveEndpoint(scope, id)
  // Prepare an attempt only when endpoint.status === 'active'.
}
```

`matchRecipients` returns the complete matching set, including paused endpoints. `resolveEndpoint` returns one of:

```ts
{ status: 'active', url: string, secrets: readonly string[] }
{ status: 'paused' }
{ status: 'deleted' }
```

Resolve each endpoint again when preparing an attempt, including retries. Active results contain the current URL and usable Standard Webhooks signing secrets. This is a server-only capability; never expose it to a browser or an untrusted caller.

A sender must follow these rules:

- Capture recipients during publication and durably store that selection. Idempotent repeats keep the accepted event's original recipients. Concurrent subscription edits can affect the selection; it does not promise a simultaneous snapshot across all records.
- Keep work for paused endpoints and continue matching their subscriptions. Resume sends eligible backlog within the sender's expiry policy.
- Treat deleted or missing endpoints as ineligible. Cancel pending work when deletion is observed. An already prepared request may still arrive.
- Propagate lookup failures. An unavailable database is not an empty recipient set or a deleted endpoint.
- Sign with Standard Webhooks and own transport validation, queuing, retries, history, retention, and delivery concurrency.

Good Webhooks delivery implements this contract and uses separate PostgreSQL storage:

```ts
import { createDelivery } from 'good-webhooks/delivery'
import { z } from 'zod'

const delivery = createDelivery({
  database: deliveryDatabase,
  source: management.source,
  events: {
    'invoice.created': z.object({ invoiceId: z.string() }),
  },
})
```

Apply `good-webhooks/migrations/delivery.sql` to that database before calling `delivery.check()`. Start `delivery.worker.run(...)` or invoke `delivery.worker.tick()` explicitly. Management and delivery databases may differ. Publication stores accepted events and deliveries atomically within delivery storage; it does not automatically share your application's business transaction.

## Destination validation

Portable management validates URL syntax, HTTPS, credentials, and unsafe IP literals. Explicit `allowLocalhost: true` permits HTTP loopback destinations for development. Standalone PostgreSQL management also resolves hostnames during registration and URL updates.

Registration cannot make future HTTP requests safe. Every sender must resolve hostnames again, reject private or otherwise unsafe addresses, and pin the validated address for the connection. Good Webhooks delivery performs these checks and does not follow redirects. A custom sender must provide equivalent protections.

## Signing rotation and storage encryption

Signing-secret rotation changes the secret shared with the receiver. The default and maximum overlap is 24 hours. During overlap, the trusted source returns the new and previous secrets. A second overlapping rotation fails unless you explicitly use `{ graceMs: 0 }`, which immediately replaces the current secret and drops the previous one.

Storage-key rotation preserves those receiver-facing secrets. For standalone management:

1. Create the provider with the new `encryptionKey` and the old keys in `decryptionKeys`.
2. Call `management.reencrypt(scope)` for every affected scope. The host owns that scope inventory.
3. Keep old keys configured until all affected records have been rewritten. Confirm the new configuration can resolve active endpoints before retiring old keys.

Reads do not rewrite ciphertext. A failed rewrite can leave a mixture of old and new ciphertext, so retain both keys and retry. Re-encryption guards against concurrent edits and signing-secret rotation. Paused endpoints are included; deleted endpoints have already cleared their secrets.

For the BA provider, use [BA's secret configuration and the same rewrite procedure](better-auth.md#storage-encryption).

## Custom management storage

`createManagement` from `good-webhooks/management` supplies the shared lifecycle over a `ManagementRepository` and `SecretCipher`. Use this extension only when neither built-in provider suits your storage. The repository must enforce the strict scope limit atomically, return every live record without truncation, and guard writes by scope, ID, and revision. Senders normally need only `EndpointSource`; they do not need to implement a repository.
