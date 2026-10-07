# Good Webhooks management and delivery separation

Status: implemented. The consumer guides describe the supported setup; the database compatibility report records the verified adapter combinations. [The design record](better-auth-integration.md) contains the source evidence, alternatives, and individual decisions.

## Result for consumers

Applications can install the Better Auth plugin for authenticated endpoint management and supply any sender that follows the endpoint lifecycle and Standard Webhooks signing contract. Installing the plugin creates no requirement for our delivery database, publisher, or worker. Applications that choose Good Webhooks delivery use the same endpoint records through an injected management provider.

| Component                       | Responsibility                                                                              | Storage and dependencies                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Better Auth plugin              | Authenticated endpoint CRUD, pause/resume, signing-secret rotation, and client integration  | Host's BA adapter and plugin schema workflow; every database natively supported by the supported BA version |
| Management provider             | Shared endpoint operations and trusted sender reads                                         | BA provider or standalone provider; independent interface                                                   |
| Optional Good Webhooks delivery | Publication, durable deliveries, attempts, retries, replay, retention, and worker execution | Explicit PostgreSQL storage and worker startup                                                              |
| Receiver verification           | Standard Webhooks signature verification                                                    | Remains usable independently                                                                                |

The standalone core has no BA runtime dependency. Keep integration dependencies and imports behind separate entry points. Preserve standalone PostgreSQL management for applications without BA. The public entry points are `good-webhooks`, `good-webhooks/management`, `good-webhooks/management/postgres`, `good-webhooks/delivery`, `good-webhooks/better-auth`, and `good-webhooks/better-auth/client`.

## Management records and ownership

The BA provider uses one endpoint model containing scope identity, URL, description, subscribed event names, active/paused/deleted state, encrypted current and previous signing secrets, previous-secret expiry, timestamps, and a revision for guarded writes. IDs are opaque strings. Each provider owns its physical schema and ciphertext representation.

Preserve the strict limit of 1,000 nondeleted endpoints per scope. A unique allocation key reserves one of 1,000 slots as part of inserting the complete endpoint record. Guarded deletion releases that slot while retaining the endpoint identity. This needs no separate coordination model. Native database tests verify concurrent creation, complete reads, guarded edits, and capacity reclamation. No delivery or attempt tables belong to the plugin.

The management API needs allowed event names without requiring publisher payload validators. Hosts can derive those names from the publisher's definitions when using both modules. Event payload validation remains the publisher's responsibility.

Personal HTTP management derives ownership from the authenticated user. Organization management checks current membership and the exact `webhookEndpoint` action. Owners or the configured creator role have full access; other roles need explicit grants. Pause, resume, and rotation require `update`. Application and custom scopes require an explicit host policy for the exact scope and action; deny access when it is absent.

HTTP management uses BA sessions initially. Trusted server code uses the management interface directly and remains responsible for authorizing callers if it exposes those operations. Organization-owned API-key HTTP management is deferred. Do not imply automatic compatibility with user API-key session impersonation without separately verifying it.

Deleting a user deletes their personal endpoints. Deleting an organization deletes its endpoints. Removing a member or deleting an endpoint's creator leaves organization-owned endpoints intact. Use BA lifecycle integration for cleanup and current owner-existence checks so missed cleanup cannot leave endpoints usable. Database lookup errors must not be mistaken for missing owners.

## Shared sender interface

The interface provides two read capabilities:

| Operation                                   | Required result                                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Match recipients for a scope and event type | A complete set of matching endpoint IDs, including paused endpoints and excluding deleted endpoints or missing owners |
| Resolve an endpoint before an attempt       | Current eligibility, URL, and usable signing material, with inactive/missing state distinct from a lookup failure     |

The sender receives this narrow interface rather than the management CRUD capability. The provider handles database mappings, ownership checks, and decryption. The sender does not query BA's physical tables. The `EndpointSource` contract names these operations `matchRecipients` and `resolveEndpoint`. Lookup errors reject instead of returning an empty or deleted result.

A separate worker constructs a provider against the same management database using compatible BA configuration, runtime, database access, and decryption keys. It needs no user session or HTTP listener. Its provider needs access to ownership records as well as endpoints. The host owns database-client lifetimes, migrations, and readiness checks. A built-in remote management service and endpoint replication are deferred.

## Publication and delivery behavior

Publication performs a complete recipient lookup, then durably stores the event and pending delivery work before reporting success. Preserve scope isolation and idempotency. Concurrent publications using the same scope/key converge on the committed event and recipient set or report a payload conflict. A losing lookup must not append recipients.

Endpoint edits overlapping lookup may produce a set that does not represent one simultaneous registry snapshot. Unchanged matching endpoints must still be included. A failed or incomplete lookup cannot silently become a partial successful publication. Complete enumeration must be proven for each adapter, including result limits and concurrent changes.

Joining an application's business transaction remains optional. Do not introduce distributed transactions to coordinate management and delivery. Separate business writes and publication retain their acknowledged crash window.

Paused endpoints retain subscriptions. Our sender keeps existing work and records new matching deliveries, then processes eligible work after resume within existing expiry limits. Deletion stops eligibility without waiting for queue cleanup. A request already prepared may still arrive. Our sender cancels pending work when it observes deletion.

Resolve current endpoint state, URL, and signing material for each attempt. A provider outage must defer sending without counting a receiver attempt or pretending the endpoint was deleted. Preserve existing expiry rules. Continue validating destinations and enforcing transport protections before sending.

Move per-endpoint delivery concurrency to delivery-owned configuration, preserving the default of two and allowed range of one through fifty. Custom senders choose their own concurrency policy. This does not add authenticated delivery-settings routes to the BA plugin.

## Signing and encryption

Preserve Standard Webhooks signing. Generate a signing secret per endpoint and return it only at creation or rotation through the management API. Ordinary endpoint reads exclude signing secrets. Trusted senders obtain the currently usable signing material through the provider.

Preserve the current rotation behavior: default and maximum 24-hour overlap, one previous secret, rejection of a second overlapping rotation, and explicit immediate replacement with `graceMs: 0`. Concurrent edits must not lose updates, revive deleted endpoints, or bypass overlap rules.

The BA provider uses public BA encryption helpers with the host's `secretConfig`. Standalone management retains its own explicit encryption configuration. Keep old storage encryption keys until affected values have been re-encrypted. Reading a record does not automatically migrate its ciphertext. Define and verify the rewrite procedure without changing receiver-facing signing secrets.

## Implementation sequence and acceptance

1. **Prove portable management storage.** Inventory the database and adapter configurations required by the supported BA version. Verify generated schemas, arrays, IDs, mappings, guarded mutations, the strict scope limit, and complete recipient enumeration. Settle whether additional management coordination storage is necessary. Do not narrow database support or relax accepted guarantees to make a prototype pass.
2. **Extract management and its contracts.** Separate management storage, validation, lifecycle, and encryption from publication and transport. Implement the standalone provider and the narrow sender interface. Preserve public behavior unless this design explicitly changes it.
3. **Build the BA integration.** Implement plugin schema, authenticated endpoints, client types, BA-backed provider, ownership cleanup, and worker initialization. Test HTTP and trusted-server paths separately, including user/org isolation, current membership, custom-scope default denial, secret exposure, and owner-deletion failures.
4. **Adapt PostgreSQL delivery.** Replace endpoint-table joins with provider reads. Keep event/delivery writes atomic inside delivery storage. Move claim coordination and per-endpoint capacity into delivery-owned storage. Verify idempotency races, provider failures, pause/delete/rotation races, and lease expiry during lookups.
5. **Verify complete consumer setups.** Cover plugin-only management with a custom sender, BA management with Good Webhooks delivery, a separate worker, and standalone use without BA. Include a configuration with different management and delivery databases. Verify packaging does not make BA or delivery dependencies mandatory for unrelated entry points. Document migration ownership, startup, key rotation, and runtime constraints.

Local verification passed with 347 tests across 16 files, TypeScript checks, the standalone delivery/retry/replay demo, and packed ESM/CommonJS consumers. The packed standalone consumer runs without Better Auth installed. A separate app/worker test uses SQLite management and PostgreSQL delivery without standalone management tables.

The [adapter report](better-auth-database-compatibility.md) records the native and ORM storage proofs and their runtime limits. CI includes the regular suite, demo, packed consumer checks, and an adapter matrix. The updated CI workflow has not been executed remotely in this worktree.

Independent correctness and simplification reviews found and resolved a publication/worker lock cycle, organization ID aliases under numeric IDs, and duplicated URL validation. The deadlock regression fails with the old lock mode and passes with the fix. No review findings remain open.

Return to the user if evidence requires dropping a native BA database, weakening completeness or strict limits, adding required external infrastructure, or changing an agreed public behavior. Routine API naming, schema mappings, and test implementation do not require another interview round.

## Deferred scope

Automatic auth-event publication, authenticated delivery history/replay routes, organization-owned API-key HTTP management, arbitrary signing formats, a built-in remote management service, replicated endpoint caches, and mandatory cross-database transactions remain outside the first release. Breaking changes are allowed; no migration path for existing prototype consumers or data is required.
