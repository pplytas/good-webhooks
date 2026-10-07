# Better Auth integration design

This document preserves the design discussion. See the [consumer guide](better-auth.md) for the implementation and [compatibility report](better-auth-database-compatibility.md) for verification evidence.

Status: implemented and locally verified. The [implementation record](better-auth-implementation-plan.md) lists completed checks and resolved review findings. Interview sections below retain the reasoning and constraints that informed those decisions.

This document replaces the earlier sketch that wrapped the complete Good Webhooks instance. [ADR 0004](adr/0004-management-without-delivery.md) records why management must work independently of our delivery engine. The package now implements this separation through independent management and delivery entry points.

## Agreed scope

- The plugin provides authenticated endpoint management. It verifies the caller and checks permission for the selected ownership scope and action.
- The plugin declares only the management tables it needs through Better Auth's normal schema tooling. The host runs the applicable migration workflow explicitly.
- Applications can use the plugin with Good Webhooks delivery or their own sender. Plugin installation must not require Good Webhooks publication, worker execution, or delivery tables.
- Applications using both the plugin and standalone library must share management records without maintaining duplicate endpoint registries.
- The plugin does not publish authentication events or expose delivery history and replay routes.
- The standalone core stays independent of Better Auth identity types and runtime dependencies, as established in [ADR 0002](adr/0002-independent-core.md). Worker execution remains explicit.
- Preserve existing product behavior unless the redesign requires an explicit change. Use established primary-source precedents to resolve routine defaults; focus interview questions on new architectural trade-offs.

## Decisions from the first interview round

- The management plugin must support every database natively supported by its supported Better Auth versions. It uses the application's existing Better Auth adapter and normal plugin schema workflow, without requiring a database change or a PostgreSQL connection. The [compatibility report](better-auth-database-compatibility.md) records the verified profiles and remaining deployment coverage limits. [ADR 0005](adr/0005-better-auth-management-storage.md) records this choice.
- Custom senders retain Standard Webhooks signing and managed signing-secret rotation. They can replace queuing, HTTP delivery, retries, and history. Arbitrary signing formats and credential schemes are outside this first design.
- Senders follow common endpoint-state and secret-rotation rules. Each sender owns its queue and retry policy. The second round below records pause, deletion, in-flight behavior, and the existing rotation settings to preserve.
- The plugin initially supports personal and organization management, following Better Auth's user and [organization membership and permission model](https://better-auth.com/docs/plugins/organization). Application-wide and custom scopes require an explicit host authorization policy. The fourth round below records permission defaults; the fifth records owner deletion behavior.
- Breaking changes to the current interface and schema are allowed. The user confirmed that the project is in its infancy and did not require an upgrade path for existing consumers or prototype data. This permission removed upgrade-path constraints for the approved implementation.
- Joining the application's business transaction is optional for this redesign. Do not build cross-adapter transaction coordination or constrain Better Auth compatibility to preserve it. Existing PostgreSQL transaction support may remain if retaining it stays simple. The publisher's own durable acceptance remains required.

## Starting implementation constraints

These describe the implementation before this redesign. The source paths now contain the separated modules; consult the consumer guides for current behavior.

- [`createWebhooks`](../packages/good-webhooks/src/index.ts) constructs endpoint management, publication, delivery history, and worker operations together.
- [`migrations/001-initial.sql`](../packages/good-webhooks/migrations/001-initial.sql) creates endpoints, events, deliveries, attempts, and a schema compatibility table. The endpoint table also contains delivery concurrency settings.
- [`src/store.ts`](../packages/good-webhooks/src/store.ts) uses PostgreSQL transactions and scope locks to coordinate endpoint mutations and publication. Endpoint removal also cancels deliveries and abandons unfinished attempts in the same transaction.
- [`src/worker-store.ts`](../packages/good-webhooks/src/worker-store.ts) reads endpoint status, URLs, signing secrets, and concurrency settings directly when claiming work.
- Publication can join a caller-owned PostgreSQL transaction. Better Auth's adapter [exposes a transaction-scoped adapter](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/core/src/db/adapter/index.ts#L399-L401), not the raw PostgreSQL connection. Separate queries cannot automatically join that transaction.
- Better Auth's schema generators can produce different physical representations for the same logical field. For example, subscriptions declared as a string array become [JSONB through Kysely](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/better-auth/src/db/get-migration.ts#L931-L941) and a [native text array through Drizzle](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/drizzle-adapter/src/relations-v2/generate-drizzle-schema.ts#L237-L245). A shared raw SQL reader needs an explicit storage contract.
- The package is currently private and versioned `0.0.0`. The user permits changing its interface and schema without preserving an upgrade path for this redesign.

[Better Auth's plugin documentation](https://better-auth.com/docs/concepts/plugins#schema) supports declaring plugin schemas. It does not establish that the current PostgreSQL schema or locking behavior can be reproduced through every Better Auth adapter. The completed adapter and concurrency experiments are recorded in the [compatibility report](better-auth-database-compatibility.md).

## Publication guarantees

The atomic-publication question bundled two different guarantees. The user decided them separately.

First, a business change and its webhook records can commit together. For example, marking an invoice paid and recording the notification in the same database transaction avoids a crash between committing the invoice change and recording the event. The current PostgreSQL implementation also creates the matching delivery records in that transaction. This does not guarantee successful or exactly-once HTTP delivery.

Second, recipient selection can have a defined order relative to endpoint changes. The original implementation serialized publication and endpoint mutations in each scope. A concurrent subscription change therefore took effect either before or after publication's selection of recipients. The eighth round below records the accepted replacement guarantee.

Using separate management storage does not inherently prevent atomic writes to business, event, and delivery records that share a PostgreSQL transaction. It does prevent assuming that endpoint reads through another adapter participate in that same transaction or scope lock. The user chose publication-time recipient lookup and accepted that overlapping edits can produce a recipient set without one scope-wide snapshot. An asynchronous outbox that defers recipient selection is outside this design.

Joining the application's business transaction is not a requirement for the first redesign. Do not build cross-adapter transaction coordination or constrain Better Auth management storage to preserve that integration. Existing PostgreSQL transaction support can remain if it survives the refactor without substantial extra complexity; removing that option alone would not remove the endpoint selection and lifecycle coupling.

Without a shared business/publication transaction, a crash after the business commit and before publication can leave the event unrecorded. This is a documented limitation of separate writes. Publication must still durably record the event and required pending work before reporting successful acceptance. Deferring application transaction integration must not turn publication into best-effort background work.

## Second interview round: recipients and endpoint lifecycle

Recipient selection and per-attempt configuration reads carry forward existing behavior. The user approved independent deletion and requested established precedent for pause semantics; the comparison below supports retaining our current buffering pause. Common endpoint rules apply to every sender. Queue retention and recipient-selection timing below describe Good Webhooks sender behavior; the management plugin does not operate a queue.

1. **Recipient selection.** Preserve matching during publication and persist that result with the event and delivery work. Later subscription changes affect future publications. Retrying the same accepted publication must not select additional recipients. The redesign changes how management records are read, not the timing of recipient selection. The eighth round defines the accepted concurrent lookup semantics; their implementation still needs verification. A new publication depends on management being available for the lookup.
2. **Pause.** Paused endpoints are temporarily ineligible for new sending attempts. Our sender retains queued work and continues recording matching deliveries while paused. Resuming makes eligible queued work available again, subject to the sender's normal retry and retention limits. An attempt already cleared to send may still complete.
3. **Deletion.** Deletion permanently removes an endpoint's eligibility. Management records the deletion without waiting for sender queue cleanup. Each sender must stop preparing attempts after observing deletion; our sender cancels pending deliveries when it observes that state. An attempt that passed its eligibility check before deletion may still reach the receiver. [ADR 0006](adr/0006-independent-endpoint-lifecycle.md) records this separation. The implemented provider retains tombstones, and the sender resolves current eligibility before preparing each attempt.
4. **Changes to the URL and signing secrets.** A sender resolves the current URL and currently usable signing secrets when preparing each attempt, including retries. It does not freeze those values when the event is published. A prepared attempt may complete with the values it already obtained. Preserve the existing rotation rules: default and maximum overlap of 24 hours, one previous secret, rejection of a second overlapping rotation, and explicit immediate replacement with `graceMs: 0`. The portable implementation must preserve those rules under concurrent edits.

### Pause precedents

Checked on 7 October 2026. Products use different semantics, including different meanings for pause and disable.

- [Hookdeck Event Gateway](https://hookdeck.com/docs/cli#hookdeck-gateway-connection-pause) queues incoming events while a connection is paused and processes queued events when unpaused. Its separate [disable operation](https://hookdeck.com/docs/connections#disable-a-connection) stops generating events for that connection and cancels pending events.
- [Convoy's open-source implementation](https://github.com/frain-dev/convoy/blob/c20cc4665b4fba1e148d7affd9487f012ffe7aff/worker/task/process_event_discard_test.go#L14-L49) explicitly tests that newly matched deliveries for paused and inactive endpoints are marked discarded. This is a source-level observation at that commit, not a claim about every hosted deployment or existing queued retry.
- [Svix](https://docs.svix.com/retries) documents that disabling or removing an endpoint disables delivery attempts. This is not evidence of a buffering pause.
- [Stripe](https://docs.stripe.com/webhooks#automatic-retries) stops future retries of an event when the destination is disabled or deleted at retry time. This also describes disable behavior, not a buffering pause.

Good Webhooks retains the Hookdeck-style buffering meaning of pause and its existing bounded retry and retention behavior. This choice preserves the current implementation and supports temporary receiver maintenance. It does not adopt other products' expiry policies or add a separate disabled state. Pausing does not reset delivery age or extend retention.

## Third interview round: management and delivery storage

The user reaffirmed that the plugin must work with whichever database Better Auth natively supports. Database neutrality for management is settled and must not be narrowed to a preferred backend during the redesign. The optional delivery engine remains a separate module with its own storage requirements.

For example, a plugin-only application using SQLite must not need PostgreSQL. The agreed provider architecture allows that application to keep its Better Auth and endpoint records in SQLite while adding PostgreSQL only for Good Webhooks event and delivery records, subject to compatible runtime and database access. PostgreSQL delivery storage must not dictate where the plugin keeps endpoint records.

The user accepted a trusted server interface for endpoint lookup across management and delivery storage in Q15. The plugin and sender use the same authoritative management records. Our publisher obtains matching endpoint IDs through that interface; our worker resolves current state, URL, and signing material before attempts. Delivery persistence remains PostgreSQL-specific. This requires no replicated endpoint registry or sender queries against Better Auth's physical tables.

The standalone composition provides the same interface through its own management storage adapter. The core depends on the interface, not Better Auth. A worker in a separate process needs access to that management provider and its configuration; runtime setup and failure behavior require design and verification. An unavailable management provider must be treated as a lookup failure, not an empty recipient set or a deleted endpoint.

This composition is implemented; its storage coverage is recorded in the [compatibility report](better-auth-database-compatibility.md). Same-database configurations remain possible. Generic remote management hosting, distributed transactions, and a replicated endpoint cache are not first-release requirements.

## Fourth interview round: management schema and access

The user accepted the authorization defaults and the first-release access methods below. Implementation was authorized after the complete design review and is now covered by integration tests.

### Proposed management model

Start with one Better Auth `webhookEndpoint` model containing ownership scope and reference, URL, description, subscribed event types, status, encrypted current and previous signing secrets, previous-secret expiry, timestamps, and an internal revision. Keep delivery concurrency configuration in the optional delivery module. A separate subscription or secret-history model is unnecessary for the existing bounded rotation behavior.

Better Auth supports logical string arrays and [converts array values for adapters without native arrays](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/core/src/db/adapter/factory.ts#L268-L274). Its query interface does not provide a portable array-element membership operation. The candidate provider therefore reads endpoints within the exact scope and matches event names in application code. Complete reads, concurrent pagination, generated schemas, and performance still need verification; the adapter's default result limit must not silently truncate recipients.

Use opaque string endpoint IDs. Investigate guarded revision writes for edits and rotation through Better Auth's [atomic mutation contract](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/core/src/db/adapter/index.ts#L440-L508). This requires adapter tests before claiming concurrency guarantees. Preserve the existing strict limit of 1,000 nondeleted endpoints per scope; count-then-create does not preserve it. The single endpoint model is a starting point, not an accepted table-count limit. An additional management-only coordination model is permitted if needed to preserve the limit, with failed-create recovery and capacity reclamation verified. Portable indexing remains an engineering design question; the seventh round settles storage encryption.

### Agreed authorization defaults

Personal endpoints belong to the authenticated user. Organization actions require current membership and a `webhookEndpoint` permission with `create`, `read`, `update`, or `delete` actions. Pause, resume, and rotation require `update`. Following [Better Auth API Keys' documented defaults](https://better-auth.com/docs/plugins/api-key/advanced#access-control--permissions), the organization owner or configured creator role receives all actions; other roles, including admins, need explicit grants. The user accepted these defaults in Q12.

### Agreed first-release access methods

The first release uses authenticated user sessions for HTTP management and provides a trusted server management interface. Trusted application code and senders can use that interface without a browser session; exposing it through HTTP requires caller authorization. The user accepted deferring organization-owned API keys for remote management in Q13.

Better Auth's [API-key session feature](https://better-auth.com/docs/plugins/api-key/advanced#sessions-from-api-keys) supports user-owned keys only. It does not supply action-scoped webhook authorization automatically. Source inspection also indicates that the synthetic session does not survive the stateful [sensitive-session middleware path](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/better-auth/src/api/routes/session.ts#L520-L572); this has not been runtime-tested. Do not promise API-key compatibility merely because management verifies sessions. Organization-owned API-key access would need a deliberate verification and permission path if selected.

## Fifth interview round: owner deletion

The user accepted Q14 on the condition that it follows Better Auth's general behavior and patterns:

- Deleting a user deletes endpoints owned by that user personally.
- Deleting an organization deletes endpoints owned by that organization.
- Removing an organization member or deleting that member's user account revokes that person's management access. It does not delete organization-owned endpoints, even when the person created them.

Endpoint deletion follows the already agreed lifecycle: management does not wait for sender cleanup, and an attempt already prepared may complete. This decision concerns ownership policy, not physical record retention or queue deletion.

The policy follows Better Auth's pattern of removing dependent records with their owning entity. Its [user deletion implementation](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/better-auth/src/db/internal-adapter.ts#L427-L465) removes account and session records, and its [organization deletion implementation](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/better-auth/src/plugins/organization/adapter.ts#L565-L597) removes memberships and invitations. Organization resources belong to the organization, while [leaving an organization](https://better-auth.com/docs/plugins/organization#leave-organization) removes membership. These are precedents for the ownership policy, not a claim that Better Auth automatically cleans up custom endpoint records.

Better Auth documents [organization deletion hooks](https://better-auth.com/docs/plugins/organization#delete-organization). Its user database deletion hooks cover both self-service and admin deletion through the [shared internal adapter](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/better-auth/src/db/internal-adapter.ts#L427-L465); the self-service callbacks alone do not cover admin removal. After-hooks can fail after deletion has committed, and direct database deletion bypasses hooks. Hook coverage, failure recovery, and current owner-existence checks therefore need explicit design. A missing owner must make its endpoints unusable even if record cleanup was missed; a failed owner lookup must remain an error rather than proof of deletion.

The API Keys ownership model is a useful precedent for separating organization resources from their creators, but its [plugin definition](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/api-key/src/index.ts#L165-L384) does not register automatic owner-deletion cleanup in version 1.7.7. Do not claim that copying its ownership fields supplies cascading cleanup. Good Webhooks must implement the agreed endpoint cleanup explicitly through Better Auth-compatible integration points.

## Sixth interview round: sharing management with senders

The user accepted Q15: the first release uses an injected server-side management provider, including in a separate worker process. A built-in remote management service is deferred. [ADR 0007](adr/0007-shared-management-provider.md) records this implemented boundary.

The agreed arrangement is:

- The Better Auth plugin manages endpoint records through the application's configured adapter.
- A Better Auth-specific helper exposes those same records through the framework-independent management interface. Trusted application code can use its management operations. Senders receive a narrower interface for matching recipient IDs and resolving current endpoint state, URL, and signing material.
- Good Webhooks delivery and custom senders consume that interface without depending on Better Auth types or querying its physical tables. A standalone application uses a separate management provider implementing the same interface.
- A separate worker creates its own provider instance against the same management database using the relevant Better Auth configuration. It does not need a user session or an HTTP listener. It does need a compatible runtime, database access, and the configured means to decrypt signing secrets. Each process connects to the same authoritative records; they do not share an in-memory object.

Better Auth exposes the initialized context through its public [`auth.$context` type](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/better-auth/src/types/auth.ts#L8-L17). The separate app/worker integration test verifies this path with SQLite management and PostgreSQL delivery. The storage matrix verifies the other listed adapter profiles without claiming every deployment combination. The host creates the helper after context initialization, outside the plugin's own initialization callback. The helper must preserve model/field mappings and apply the agreed owner-existence and lifecycle rules. The worker therefore needs owner-table read access as well as endpoint access. Awaiting the context does not apply migrations or establish full schema readiness; the host owns client lifetimes, migrations, and readiness checks.

Database portability for the plugin remains mandatory. Worker deployment must also respect the configured driver's runtime and data access constraints. A file-backed SQLite database, for example, must be accessible to the worker as the same database; a separate file with the same schema is not shared storage. SQLite [in-memory databases](https://www.sqlite.org/inmemorydb.html) cannot be shared across separate processes, and [Cloudflare D1 bindings](https://developers.cloudflare.com/d1/worker-api/) require the appropriate runtime. If a worker cannot use the provider, the first release does not promise a built-in remote access service or replicated endpoint cache.

## Seventh interview round: storage encryption configuration

The user delegated Q16 to engineering judgment on the condition that the choice follows Better Auth plugin conventions. The selected design encrypts stored webhook signing secrets with the host's existing Better Auth secret configuration, following Better Auth's [two-factor plugin](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/better-auth/src/plugins/two-factor/index.ts#L243-L251). This is an established Better Auth plugin pattern, not a framework requirement that all plugins use the same key. A dedicated webhook encryption-key override is deferred until independent key ownership is required.

Each endpoint still has its own Standard Webhooks signing secret. The storage encryption key protects that value in the database; it is not sent to receivers. The Better Auth provider uses the public `better-auth/crypto` helpers with `secretConfig`, which supports both singular and versioned keys. The standalone provider retains its own explicit encryption configuration. The sender receives usable endpoint signing material through the agreed provider interface, so it does not depend on either provider's ciphertext format.

The app and any separate worker must use compatible current and retained encryption keys. Better Auth's [versioned secrets](https://better-auth.com/docs/reference/options#secrets) allow new writes to use a new key while older ciphertext remains decryptable with retained keys. Reading a value does not automatically rewrite it. Removing an old key before its stored values have been re-encrypted makes those values unreadable; the implemented `management.reencrypt(scope)` procedure rewrites live records while preserving signing values and guarding concurrent edits. Changing storage encryption keys must not silently change endpoint signing secrets or their receiver-facing rotation rules.

## Eighth interview round: concurrent recipient selection

The user accepted Q17: publication may observe different endpoints at different moments during a complete recipient lookup, without promising one scope-wide snapshot across every management adapter. Publication-time matching and the fixed recipient set after acceptance remain required. [ADR 0008](adr/0008-recipient-lookup-consistency.md) records the change from the current shared scope lock.

Before the redesign, endpoint mutations and publication took the same PostgreSQL scope lock. The new provider boundary removes that shared lock. Better Auth's [generic transaction contract](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/core/src/db/adapter/index.ts#L509-L515) allows sequential execution without a transaction when the adapter does not support one, so calling it does not establish a portable snapshot guarantee. A stronger universal contract would require additional coordination or adapter-specific support. Stronger native read consistency can still be used where available.

The agreed guarantee is:

- Include matching endpoints whose registration and subscription changes completed before publication began, provided those endpoints remain unchanged during lookup. This requires authoritative reads and complete enumeration, both of which must be verified for supported configurations.
- Changes that overlap publication may affect that publication. Different endpoints may reflect different committed states observed during lookup; the complete recipient set need not represent one shared instant.
- Persist one recipient set with the event and pending delivery work before reporting success. An accepted idempotent repeat keeps that set. Concurrent calls using the same scope and idempotency key must converge on the committed result or report a payload conflict; a losing lookup must not append recipients.
- A lookup error, timeout, or incomplete enumeration must not produce a successful publication with partial recipients. The adapter's default row limit and pagination must not silently skip unchanged matching endpoints.

For example, A initially subscribes and B does not. Publication reads A, then the application unsubscribes A and subscribes B, in that order. Publication subsequently reads B. The agreed contract permits both recipients, even though A and B were never subscribed simultaneously. The existing scope lock prevents this mixed result.

Implementation must prove complete bounded reads with overflow detection or a stable enumeration method for each adapter. Ordinary offset pagination can skip untouched endpoints when earlier rows disappear. The weaker snapshot contract does not permit that loss, arbitrary stale reads, scope leakage, or best-effort publication. Existing pause, deletion, owner-existence, and per-attempt configuration rules still apply.

## Engineering work remaining

The final gap audit found no further product decision requiring user input. Resolve the following through engineering design and verification, using native Better Auth conventions and preserving accepted behavior. Return to the user only if evidence requires changing scope, externally visible behavior, deployment requirements, or guarantees. Database compatibility, provider setup mechanics, DTO formatting, and test coverage are not preference questions by themselves.

| Decision group             | Questions to settle                                                                                                                                                                | Depends on                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Database compatibility     | How will tests cover the required Better Auth-native databases and configurations? Which runtime constraints apply when composing with PostgreSQL delivery?                        | BA-native management requirement, adapter feasibility     |
| Sender contract            | What are the exact provider methods, result types, failure behavior, and lifecycle checks for recipient matching and endpoint resolution?                                          | Agreed shared provider, state, and signing rules          |
| Identity and permissions   | How are the agreed session, membership, action, and owner-existence checks enforced? How do host policies cover application/custom scopes?                                         | Agreed ownership, deletion, and access defaults           |
| Endpoint lifecycle         | How are deletion observation, cleanup, and preserved rotation rules implemented safely under concurrent operations?                                                                | Agreed lifecycle rules and existing rotation behavior     |
| Management data            | Which records and fields belong to management? How are subscriptions, credentials, rotation, limits, and concurrent edits represented and protected?                               | Database support, sender contract, lifecycle              |
| Shared storage             | How are provider setup, management and delivery migrations, and schema readiness exposed to hosts and separate processes?                                                          | Agreed shared provider, database support, management data |
| Recipient selection        | How does lookup handle concurrent subscription changes while preserving publication-time selection and idempotent retries?                                                         | Agreed recipient timing, management storage               |
| Public interfaces          | What does management expose to trusted server code, custom senders, HTTP callers, and browser clients? How are configuration, event types, dates, secrets, and errors represented? | Permissions, sender contract, management data             |
| Packaging and verification | Which exports and dependencies are optional? Which concurrency, isolation, migration, adapter, and consumer tests define release acceptance?                                       | Agreed interfaces and supported configurations            |

The product interview is ready for final shared-understanding confirmation against the consolidated plan. Engineering proofs remain necessary before claiming compatibility or correctness. Documentation updates during the interview do not authorize production implementation.
