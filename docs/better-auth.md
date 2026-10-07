# Better Auth management plugin

The Good Webhooks plugin adds authenticated endpoint management to Better Auth. It uses the host's configured BA adapter and one management model. Installing it does not require PostgreSQL delivery storage or start a sender.

This integration targets Better Auth 1.7.7 and the package's Node.js 24+ runtime. Database compatibility depends on BA's adapter and schema workflow; the plugin has no SQL-specific management API. See the [database compatibility results](better-auth-database-compatibility.md) for the adapter combinations exercised in this version.

## Configure and migrate

Add `goodWebhooks` to your existing auth configuration:

```ts
import { betterAuth } from 'better-auth'
import { goodWebhooks } from 'good-webhooks/better-auth'

export const eventTypes = ['invoice.created', 'invoice.paid'] as const

export const auth = betterAuth({
  database, // Your existing BA database or adapter.
  secret: process.env.BETTER_AUTH_SECRET!,
  plugins: [goodWebhooks({ eventTypes })],
})
```

Use BA's normal [CLI schema workflow](https://better-auth.com/docs/concepts/cli) after adding the plugin. With its built-in adapter, `auth migrate --config ./src/auth.ts` applies the schema. For Prisma or Drizzle, `auth generate --config ./src/auth.ts` generates schema definitions; apply them using your ORM's migration tooling. Use a CLI version compatible with your installed BA version.

The plugin declares the `webhookEndpoint` model, including a unique allocation index that enforces the per-scope endpoint limit. Preserve generated fields and indexes. You can customize model and field names through `goodWebhooks({ eventTypes, schema: { modelName, fields } })`. This option does not select a PostgreSQL namespace; do not pass a dotted name such as `notifications.webhookEndpoint` as `modelName`.

BA's database or ORM configuration determines where the management model lives. With native PostgreSQL, an explicit Kysely configuration supports `schemaName`. Drizzle's runtime table definitions determine their PostgreSQL schema; its adapter's `schemaName` configures CLI generation. Prisma placement belongs to the Prisma configuration. Use the same configuration and generated schema for the app and worker.

Do not apply `management.sql` to a BA database. That migration belongs to the separate standalone PostgreSQL provider. Good Webhooks never applies migrations during plugin initialization.

## Authenticated management

Install the client plugin with the same event names to retain TypeScript inference:

```ts
import { createAuthClient } from 'better-auth/client'
import { goodWebhooksClient } from 'good-webhooks/better-auth/client'

const authClient = createAuthClient({
  plugins: [goodWebhooksClient({ eventTypes })],
})

const { data, error } = await authClient.goodWebhooks.create({
  url: 'https://receiver.example/webhooks',
  eventTypes: ['invoice.created'],
})
```

Omitting `scope` selects the current user's personal endpoints. An explicit user scope must match that user. For organization management, pass `scope: { type: 'organization', id: organizationId }`.

| Client method               | Server method                          | Permission |
| --------------------------- | -------------------------------------- | ---------- |
| `goodWebhooks.create`       | `auth.api.createWebhookEndpoint`       | `create`   |
| `goodWebhooks.list`         | `auth.api.listWebhookEndpoints`        | `read`     |
| `goodWebhooks.get`          | `auth.api.getWebhookEndpoint`          | `read`     |
| `goodWebhooks.update`       | `auth.api.updateWebhookEndpoint`       | `update`   |
| `goodWebhooks.pause`        | `auth.api.pauseWebhookEndpoint`        | `update`   |
| `goodWebhooks.resume`       | `auth.api.resumeWebhookEndpoint`       | `update`   |
| `goodWebhooks.remove`       | `auth.api.removeWebhookEndpoint`       | `delete`   |
| `goodWebhooks.rotateSecret` | `auth.api.rotateWebhookEndpointSecret` | `update`   |

All routes use POST under BA's configured base path at `/good-webhooks/{operation}`. Rotation uses `/good-webhooks/rotate-secret`. Server `auth.api` calls use `{ body, headers }` and require the current user's session headers too.

Create and rotation return `{ endpoint, secret }`. Transfer the secret securely to the receiver. Ordinary reads omit signing secrets. HTTP and client timestamps are ISO strings; trusted management results use `Date` values. The plugin's JSON parser preserves descriptions that happen to look like timestamps.

Organization-owned API keys are not an authentication path for these routes. This version does not promise compatibility with user API-key session impersonation.

## Organization permissions

Install BA's organization plugin for organization-owned endpoints. Add the `webhookEndpoint` resource to [BA access control](https://better-auth.com/docs/plugins/organization#access-control):

```ts
import { createAccessControl } from 'better-auth/plugins/access'
import { organization } from 'better-auth/plugins/organization'
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from 'better-auth/plugins/organization/access'

const ac = createAccessControl({
  ...defaultStatements,
  webhookEndpoint: ['create', 'read', 'update', 'delete'] as const,
})

const organizations = organization({
  ac,
  roles: {
    owner: ac.newRole(ownerAc.statements),
    admin: ac.newRole({
      ...adminAc.statements,
      webhookEndpoint: ['create', 'read', 'update', 'delete'],
    }),
    member: ac.newRole(memberAc.statements),
  },
})
```

Add `organizations` to the auth instance's `plugins` alongside `goodWebhooks`. The organization plugin's configured creator role has full endpoint access. That role defaults to `owner`. Every other role needs explicit grants. The example grants admins all four actions; admins do not receive these permissions merely because their role is called `admin`.

Each request checks current membership and the requested action. Removing a member removes their management access while the organization's endpoints remain active. Deleting a user retires their personal endpoints. Deleting an organization retires its endpoints. Trusted sender lookups also check that the owner still exists, so missed cleanup does not leave orphaned endpoints eligible.

For application scope (`scope: null`) or custom scope types, supply `authorizeScope({ scope, action, user, session })`. It must authorize that exact scope and action. The default is denial. This callback cannot override personal ownership or organization permissions.

## Trusted server access and custom senders

Get the shared management provider from the configured auth instance:

```ts
import { createBetterAuthManagement } from 'good-webhooks/better-auth'

const management = await createBetterAuthManagement(auth)
const source = management.source
```

This helper needs no user session or HTTP listener. It accesses the same endpoint records as the plugin through BA's adapter. Direct management calls bypass HTTP authorization because they are trusted server capabilities. If your application exposes them, it must authorize the caller first.

Pass only `source` to a custom sender. Its two operations match recipient IDs and resolve current endpoint state, URL, and signing material. Follow the [sender lifecycle and destination-validation contract](management.md#supplying-your-own-sender). BA management performs portable URL checks; a custom sender must also resolve, validate, and pin destinations before connecting.

## Add Good Webhooks delivery

Management can remain in SQLite while publication and delivery use PostgreSQL:

```ts
import { createDelivery } from 'good-webhooks/delivery'
import { createBetterAuthManagement } from 'good-webhooks/better-auth'
import { z } from 'zod'

const management = await createBetterAuthManagement(auth)
const delivery = createDelivery({
  database: deliveryPostgresPool,
  source: management.source,
  events: {
    'invoice.created': z.object({ invoiceId: z.string(), total: z.number() }),
    'invoice.paid': z.object({ invoiceId: z.string() }),
  },
})

await delivery.check()
await delivery.forScope({ type: 'organization', id: organizationId }).publish({
  type: 'invoice.paid',
  data: { invoiceId },
  idempotencyKey: `invoice.paid:${invoiceId}`,
})
```

Delivery defaults to the `public` schema with tables prefixed by `webhook_`. Apply `good-webhooks/migrations/delivery.sql` only to the delivery database. Publication requires management storage for recipient lookup, while accepted events and pending deliveries are committed together inside PostgreSQL. A separate business database commit is not automatically atomic with publication.

If BA and delivery use the same custom PostgreSQL schema, share an explicit constant between their configurations and migration generation:

```ts
import { getPostgresMigration } from 'good-webhooks/migrations'

const webhookSchema = 'notifications'
const auth = betterAuth({
  database: { db: authKysely, type: 'postgres', schemaName: webhookSchema },
  secret: process.env.BETTER_AUTH_SECRET!,
  plugins: [goodWebhooks({ eventTypes })],
})
const management = await createBetterAuthManagement(auth)
const delivery = createDelivery({
  database: deliveryPostgresPool,
  schema: webhookSchema,
  source: management.source,
  events,
})
const deliverySQL = getPostgresMigration({ schema: webhookSchema, component: 'delivery' })
```

Here `authKysely` is the host's PostgreSQL Kysely instance. BA's own migration workflow still creates its management model. Apply `deliverySQL` separately through your migration runner. The delivery `schema` option does not change BA configuration or infer its namespace. Different management and delivery schemas or databases are also supported.

The [SQLite auth example](../examples/better-auth/auth.ts), [delivery setup](../examples/better-auth/delivery.ts), and [worker entry function](../examples/better-auth/worker.ts) are typechecked examples. They export functions and do not start workers on import.

## Separate worker process

The worker imports the same auth configuration, constructs `createBetterAuthManagement(auth)`, and passes its source to `createDelivery`. It needs access to the same management database, compatible plugin configuration, BA storage encryption keys, and the delivery database. No call to `auth.handler` or sign-in is required.

For a file-backed SQLite example, app and worker must open the same persistent file. Two `:memory:` databases or two container-local files do not share records. Use a deployment and BA adapter that both processes can access. The host owns migrations, database lifetimes, worker startup, shutdown, and error reporting.

## Storage encryption

The provider uses BA's encryption helpers with the auth instance's `secretConfig`. Each endpoint still has its own receiver-facing Standard Webhooks signing secret.

To rotate the BA storage encryption key, configure [BA's versioned secrets](https://better-auth.com/docs/reference/options#secrets) with the new key first and retain the previous keys. Initialize app and worker with the same configuration. Call `management.reencrypt(scope)` for every affected scope, then verify those records with the new configuration before removing old keys. The host supplies the scope inventory.

Changing BA configuration or reading an endpoint does not rewrite its ciphertext. Retain old keys while any affected record remains. If a rewrite fails, preserve both keys and retry. Re-encryption preserves receiver-facing signing values; `rotateSecret` is the separate operation that changes those values.
