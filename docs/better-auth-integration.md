# A future Better Auth integration

A Better Auth plugin could authenticate management requests, check permissions, and call the same scope-bound server operations that applications use directly. The delivery core has no Better Auth dependency and accepts no Better Auth user, session, or organization types.

This is a design acceptance sketch, not a plugin shipped in v0.

## Identity and permissions

The host decides which scope an operation should use. A personal webhook can use `{ type: 'user', id: userId }`; an organization webhook can use `{ type: 'organization', id: organizationId }`. The same ID in those namespaces remains isolated. Application-wide webhooks can use the root instance directly.

A later plugin would select the appropriate scope from a verified session and check the caller's permission for each action. The core would continue enforcing ownership inside every operation.

The following sketch shows the boundary with application-defined authorization functions. The function names do not represent Better Auth APIs:

```ts
import type { EndpointInput } from 'webhook-dispatch'
import { events, webhooks } from './application-webhooks.js'

type AuthorizedContext = { type: 'user' | 'organization'; id: string }

// A future plugin calls these functions after session and permission checks.
export function webhookManagement(context: AuthorizedContext) {
  const scoped = webhooks.forScope(context)
  return {
    createEndpoint: (input: EndpointInput<typeof events>) => scoped.endpoints.create(input),
    listEndpoints: () => scoped.endpoints.list(),
    pauseEndpoint: (id: string) => scoped.endpoints.pause(id),
    resumeEndpoint: (id: string) => scoped.endpoints.resume(id),
    rotateSecret: (id: string) => scoped.endpoints.rotateSecret(id),
    inspectDelivery: (id: string) => scoped.deliveries.get(id),
    replayDelivery: (id: string) => scoped.deliveries.replay(id),
  }
}
```

The adapter must not accept scope identifiers from an unchecked request body. Permission checks must cover sensitive operations such as secret rotation, replay, and response-history access. A secret returned by creation or rotation belongs only in the authorized response.

## Typed HTTP endpoints

[Better Auth plugins](https://www.better-auth.com/docs/concepts/plugins) support server endpoints and corresponding client inference. A future plugin could expose these management operations through that mechanism.

Core methods return typed results and throw `WebhookError` with stable error codes. A plugin would map those codes to its HTTP error contract. For example, `NOT_FOUND` could map to a missing resource, while `IDEMPOTENCY_CONFLICT` would indicate conflicting publication content.

The plugin would own HTTP serialization, including date strings and error responses. It would not duplicate subscription, ownership, retry, or replay rules.

## Worker and database ownership

Constructing the core starts no worker and changes no database schema. Better Auth initialization would do neither of those tasks.

The application would still supply a PostgreSQL pool, apply package migrations explicitly, and run `worker.run({ signal })` in its chosen process. The plugin would call management operations on that configured instance.

[Request background work](https://www.better-auth.com/docs/concepts/hooks#runinbackground) does not replace durable delivery records or PostgreSQL worker leases. Delivery must continue after the request or auth process ends.

The webhook package owns the contents and versions of its SQL migrations. The host owns their execution. A future plugin must not silently transfer those tables to Better Auth's schema management.

## Business-event publication

Applications can publish inside their own PostgreSQL transaction through `scoped.publish(input, { transaction: client })`. That transaction controls whether the event and its deliveries become visible to workers.

A plugin must preserve this explicit boundary. An auth hook that runs after a commit cannot make a webhook publication atomic with the original mutation. Better Auth's portable database adapters are not interchangeable with a PostgreSQL client merely because they expose transaction helpers.

No general plugin framework, Better Auth database adapter, or browser client is required to keep this integration possible. The acceptance check for v0 is that this sketch calls public operations without importing internal storage or delivery code.
