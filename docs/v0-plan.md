# Good Webhooks v0

Status: accepted, 6 October 2026. Name updated 7 October 2026. Approved name: Good Webhooks. Package and repository slug: `good-webhooks`.

## Product scope

Build a general-purpose embedded TypeScript server package for public OSS use. A new application must be able to use it without any company-specific identities, schemas, event types, or internal dependencies. Adoption by a particular company is a separate project and is not an acceptance criterion here.

V0 delivers a standalone package, explicit database setup, documentation, and a runnable example. It includes endpoint management, durable publication, HTTP delivery, signing, retries, attempt history, and replay. HTTP management routes, a browser client, a dashboard, and a Better Auth plugin remain outside v0.

The GitHub repository is [pplytas/good-webhooks](https://github.com/pplytas/good-webhooks), under the user's personal account. npm publication remains a separate release action.

## Interface and runtime

- Start with Node.js 24 and PostgreSQL 16 or later. Use one structural database interface that accepts a node-postgres pool.
- Configure one typed factory. Infer event names and payload inputs from Standard Schema validators.
- Expose direct operations for the application scope and optional `forScope({ type, id })` clients for isolated named scopes. Enforce scope isolation inside every operation. The host authorizes scope selection.
- Keep authentication, user and organization permissions, business-event production, and custom recipient entitlement policy in the host.
- Publish events and matching deliveries transactionally. Support the caller's existing PostgreSQL transaction. Report acceptance separately from remote delivery.
- Start and stop workers explicitly. Imports and factory construction do not connect, apply DDL, or start polling.
- Apply versioned SQL migrations explicitly through the application's chosen migration process.
- Provide stable errors, immutable event payloads, bounded retries and concurrency, durable attempt history, and controlled replay.
- Use Standard Webhooks for the wire contract. Implement signing and verification with native cryptography and check independent compatibility.
- Validate customer-controlled destinations on every request. Use HTTPS, public network addresses, pinned DNS results, timeouts, and bounded responses. Permit loopback HTTP only through an explicit development option.
- Keep history retention explicit and bounded. A retry or replay preserves the event identity. Delivery can be duplicated and is unordered.

No queue framework or Standard Webhooks npm dependency has been selected. V0 does not build an adapter ecosystem, an interactive setup CLI, or a general plugin framework.

## Better Auth influence and future integration

Borrow the typed factory, coherent server operations, inference, stable errors, and clear schema setup described in Better Auth's [TypeScript guide](https://better-auth.com/docs/concepts/typescript), [API guide](https://better-auth.com/docs/concepts/api), and [database guide](https://better-auth.com/docs/concepts/database). Do not copy source code. Borrow optional ownership from the [organization plugin](https://better-auth.com/docs/plugins/organization): keep the base workflow simple without adding identity or membership models to the webhook core.

Keep all core operations independent of a Better Auth instance, user, session, or organization type. A future optional plugin can authenticate callers, check permissions, and select application-defined scopes. The plugin can expose endpoints and inferred client calls by composing typed public operations rather than duplicating domain rules.

Worker execution, PostgreSQL transactions, and migration ownership remain explicit. Auth initialization or request-background execution must not become the delivery engine. Review the [integration sketch](better-auth-integration.md) against the completed interface without implementing that plugin.

## Acceptance criteria

1. Install a locally packed tarball in a fresh consumer application and verify runtime exports, types, migrations, and supported imports.
2. Run an example that registers an endpoint, publishes, verifies a signed request, retries a failure, inspects history, and replays a delivery.
3. Verify transaction rollback, idempotency, application and named scope isolation, subscription changes, pause and resume, removal, rotation, and replay on real PostgreSQL.
4. Verify competing workers, expired claims, fencing of stale results, bounded retries, and the duplicate-delivery case after a receiver accepts a request but success is not recorded.
5. Verify payload validation, unsafe destinations, bounded responses, signature interoperability, and cancellation.
6. Review correctness and API usability independently with subagents. Resolve substantive findings before completion.

The approved tagline is "Build webhook delivery into your TypeScript application." Public release remains a separate milestone. Production operations and downstream integration are not implied by local acceptance checks.
