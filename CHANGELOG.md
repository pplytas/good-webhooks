# Changelog

## 0.4.0 (2026-10-18)

Retries now cover about 28 hours by default, and a full scope reports its own error code. `0.3.0` announced both changes, and this release follows the [0.x minor rules](apps/docs/content/docs/operations/compatibility.mdx#releases). The database schema stays at version `5`, so no SQL is needed. [ADR 0013](docs/adr/0013-retry-every-unsuccessful-response.md) records the schedule.

### Upgrade

1. Restart producers and workers on `0.4.0`. No migration is required.
2. If you set `retentionMs` below 48 hours without `retry.maxAgeMs`, set `retry.maxAgeMs` too. Otherwise the constructor throws `INVALID_CONFIG`, because retention must cover the age limit.
3. If you check for `INVALID_STATE` when creating an endpoint in a full scope, check for `ENDPOINT_LIMIT`. A custom `ManagementRepository` should throw `ENDPOINT_LIMIT` at the limit and `INVALID_INPUT` for a limit outside 0 to 1,000.

### Breaking

- **Longer default retries.** `retry.delaysMs` defaults to 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h: eight attempts over about 28 hours, instead of seven over about 43 minutes. `retry.maxAgeMs` defaults to 48 hours (was 24). Set both to keep the old schedule.
- **`ENDPOINT_LIMIT`.** Creating an endpoint in a scope at its `maxEndpoints` limit throws the new `ENDPOINT_LIMIT` code instead of `INVALID_STATE`, so apps can show their own message ([#74](https://github.com/pplytas/good-webhooks/issues/74)). Better Auth still answers `409`, with code `ENDPOINT_LIMIT`.

### Fixed

- The PostgreSQL repository reports a limit outside 0 to 1,000 as `INVALID_INPUT`, like the Better Auth repository.

## 0.3.0 (2026-10-18)

Endpoint owners can now send a test event, the worker retries every unsuccessful response except `410`, and scopes can have a lower endpoint limit. `0.2.1` announced these changes, and this release follows the [0.x minor rules](apps/docs/content/docs/operations/compatibility.mdx#releases). The database schema stays at version `5`, so no SQL is needed. [Issue #75](https://github.com/pplytas/good-webhooks/issues/75) tracked the work, and [ADR 0013](docs/adr/0013-retry-every-unsuccessful-response.md) and [ADR 0014](docs/adr/0014-test-event-outside-delivery.md) record the design.

### Upgrade

1. Restart producers and workers on `0.3.0`. No migration is required, and `0.2.x` processes can keep running alongside.
2. Receivers that read `event.data` without checking `event.type` stop compiling: check `event.type` first, and answer `good-webhooks.test` with `2xx`.
3. Rename any event type that starts with `good-webhooks.`. Configuration now rejects it.
4. A custom `EndpointManagement` needs `sendTestEvent`. A custom `ManagementRepository` receives a third `limit` argument in `create` and must enforce it.

### Breaking

- **Every non-2xx response is retried.** `3xx` and `4xx` responses now get retries within `retry.delaysMs` and `retry.maxAgeMs`, like `5xx`. Only `410` still ends a delivery at once, also with `pauseOnGone: false`. A transient `404` during a domain cutover no longer loses the event ([#74](https://github.com/pplytas/good-webhooks/issues/74)).
- **`parseWebhook()` returns test events.** `ParsedWebhook<E>` includes `ParsedTestEvent` (`type: 'good-webhooks.test'`, `data: { endpointId }`), accepted without an event map entry.
- **Reserved event names.** `createDelivery()`, `createWebhooks()`, `createManagement()`, and the Better Auth plugin reject event types that start with `good-webhooks.`.
- **Interfaces hosts implement.** `EndpointManagement` gains `sendTestEvent`, and `ManagementRepository.create(scope, endpoint, limit)` gains `limit`.

### Added

- **Test events.** `endpoints.sendTestEvent(id)` on `createWebhooks()` clients, `EndpointManagement.sendTestEvent(scope, id)`, the Better Auth route `POST /good-webhooks/send-test-event` (`update` permission, 10 requests per minute), and `authClient.goodWebhooks.sendTestEvent()`. It signs one test event like a delivery, sends it to an active or paused endpoint, and returns `TestEventResult`: `ok`, `responseStatus`, the first 4 KiB of `responseBody`, `durationMs`, and `error`. It records nothing, never retries, and doesn't count toward automatic pauses.
- **`maxEndpoints(scope)`** on `createWebhooks()`, `createPostgresManagement()`, `createManagement()`, and the Better Auth plugin lowers the endpoint limit per scope (0 to 1,000). Both built-in providers enforce it under concurrent creates. Type: `EndpointLimit`.
- **`eventType` on `Delivery`** and `DeliveryDetail`, from `deliveries.list()`, `get()`, and `replay()`.
- Docs: a Next.js section in [Add delivery to Better Auth](apps/docs/content/docs/better-auth/delivery.mdx) that builds the engine on first use, so `next build` doesn't need runtime secrets.

## 0.2.1 (2026-10-17)

Public APIs, dependencies, and database schema (version `5`) are unchanged from `0.2.0`. No migration is required.

- The npm package no longer includes `examples/`. The examples stay in the [repository](https://github.com/pplytas/good-webhooks/tree/main/packages/good-webhooks/examples), and the docs include them. They were never part of the public API.
- The bundled Agent Skill points to the examples on GitHub instead of `node_modules`.
- The npm README describes endpoint health in plainer words.

## 0.2.0 (2026-10-16)

The worker now pauses endpoints that keep failing, reports what it does through hooks, and honors `Retry-After`. `0.1.1` announced these changes, and this release follows the [0.x minor rules](apps/docs/content/docs/operations/compatibility.mdx#releases). The new behaviors are on by default, and storage moves to schema version `5`. [Issue #58](https://github.com/pplytas/good-webhooks/issues/58) tracked the work, and [ADR 0012](docs/adr/0012-automatic-pause-through-management.md) records the design.

### Upgrade

1. Apply `getPostgresUpgrade({ from: 4 })`, or `migrations/upgrades/005-all.sql` (per-component files for separate namespaces), with your migration runner. It only adds nullable columns, so processes on `0.1.x` keep working until they restart. From version 3, `from: 3` applies both steps.
2. With Better Auth management, run your Better Auth migration (`auth migrate`, or `auth generate` and your ORM's migration) for the new optional `pauseReason` field before deploying. The new package writes it.
3. Restart producers, then workers, on `0.2.0`. See the [rollout order](apps/docs/content/docs/operations/migrations.mdx#rollout-order).
4. If your engine's `source` is a custom `EndpointSource` without `pause()`, a worker now refuses to start with `INVALID_CONFIG`. Implement `pause()` or pass `endpointHealth: false`. Engines that only publish are unaffected. Report a `revision` from `resolveEndpoint()` too. Without it, only a success starts a new failure period.
5. A custom `ManagementRepository` now receives `pauseReason` in `create` records and in `pause`, `resume`, and `remove` patches. Store it, or drop it before writing if your storage rejects unknown fields.

### Breaking

- **Schema upgrade required.** Schema version `5` adds `webhook_endpoints.pause_reason` and, on `webhook_endpoint_state`, `failing_since` and `failing_revision`. `check()` on `0.2.0` refuses version 4 storage and names the upgrade.
- **Automatic pauses, on by default.** When every attempt to an endpoint has failed for five days (`endpointHealth.pauseAfterMs`), or it answers `410 Gone` (`endpointHealth.pauseOnGone`), the worker pauses it with `pauseReason` `'failing'` or `'gone'`. Nothing is deleted, and `resume()` works as usual. A success, any endpoint change, or a resume starts a new period. Abandoned attempts don't count. `endpointHealth: false` restores the previous behavior.
- **`Retry-After` honored by default.** On `429` and `503`, the next attempt waits at least as long as the header asks (seconds or an HTTP date), but never past `retry.maxAgeMs`. A longer wait fails the delivery. `retry.respectRetryAfter: false` restores the plain schedule.

### Added

- `Endpoint.pauseReason`: `'owner'` after `pause()`, `'failing'` or `'gone'` after an automatic pause, and `null` otherwise. The Better Auth routes and client return it too.
- `hooks.onAttempt` and `hooks.onEndpointPaused` on `createWebhooks()` and `createDelivery()`. The worker awaits them after it commits each outcome. Their errors join the batch errors without changing outcomes. Types: `DeliveryHooks`, `AttemptEvent`, `EndpointPausedEvent`, `EndpointHealthOptions`, `PauseReason`.
- `EndpointSource.pause()` and an optional `revision` on active resolutions, with `AutomaticPauseInput` and `AutomaticPauseReason`. The built-in PostgreSQL and Better Auth providers implement both. Custom senders can call `pause()` to apply the same policy.
- `getPostgresUpgrade()` accepts `from: 3` or `from: 4`. Shipped upgrade files never change, so `migrations/upgrades/005-*.sql` adds the new step.
- CI rehearses the upgrade from the latest published release (`0.1.1`) with a pending backlog.

## 0.1.1 (2026-10-16)

Public APIs, dependencies, and database schema (version `4`) are unchanged from `0.1.0`. No migration is required.

- Every delivery attempt sends `user-agent: good-webhooks/<version>`. Node.js sends no user agent by default, and some firewalls reject requests without one. The header is not signed.
- PostgreSQL 18 is supported. CI runs the full integration suite on PostgreSQL 16, 17, and 18, and on Node.js 26 with PostgreSQL 18.
- The [stability policy](apps/docs/content/docs/operations/compatibility.mdx#stability-policy) now states that additions (new optional options, result fields, exports, and request headers) are not breaking. Before `1.0`, a minor may change a default or require upgrade SQL without a deprecation period, provided the previous release announces it.
- Install commands in the docs and the npm README name Better Auth 1.7.10, the newest 1.7 release, instead of 1.7.7. The supported range is unchanged.

### Coming in 0.2.0

`0.2.0` will be a breaking minor, tracked in [issue #58](https://github.com/pplytas/good-webhooks/issues/58):

- **Upgrade SQL required.** Storage moves to schema version `5`. Better Auth users also run a schema migration for a new endpoint field.
- **Automatic pause, on by default.** The worker pauses an endpoint that has failed every attempt for five days, or that answers HTTP 410. Opt out with `endpointHealth: false`.
- **`Retry-After` honored by default** on 429 and 503 responses. Opt out with `retry.respectRetryAfter: false`.

## 0.1.0 (2026-10-16)

First stable release. The public API, the shipped SQL, and the schema upgrade path now follow the [stability policy](apps/docs/content/docs/operations/compatibility.mdx#stability-policy): semantic versioning, a deprecation in an earlier minor before any breaking change, and security fixes for the previous minor for three months. `0.1.0` claims a stable API and upgrade path, not verified behavior at throughput beyond the [measured profile](apps/docs/content/docs/operations/performance.mdx).

The code, public APIs, dependencies, and database schema (version `4`) are identical to `0.1.0-beta.6`. No migration is required from beta.2 or later; from beta.1, apply the schema 4 upgrade described under `0.1.0-beta.2`. Install commands no longer name the `beta` tag.

## 0.1.0-beta.6 (2026-10-16)

Better Auth 1.8 support. Runtime behavior, public APIs, and database schema are unchanged from `0.1.0-beta.5`. No migration is required.

- The optional Better Auth peer range is now `>=1.7.7 <1.8.0 || >=1.8.0-beta.0 <1.9.0-0`, so npm installs with Better Auth 1.8 and its 1.8.0 betas no longer fail with a peer conflict. The 1.8.0-beta.0 breaking changes cover device authorization, OAuth provider, and sign-up flows, none of which the plugin uses.
- CI runs the Better Auth type check, integration tests, adapter matrix, and packed-consumer check on 1.7.7 and on the newest 1.7 and 1.8 releases, with the matching `auth` CLI generating Drizzle and Prisma schemas. CI also runs every Monday so new Better Auth releases are tested without a change here.

## 0.1.0-beta.5 (2026-10-15)

Documentation update for the redesigned site. The npm README shows the new square logo and a pipeline diagram in the same style as [good-webhooks.dev](https://good-webhooks.dev), its badges use the site font, and the endpoint example uses `receiver.example`. Images from earlier README versions stay online, so their READMEs keep working. Runtime behavior, public APIs, dependencies, and database schema are unchanged from `0.1.0-beta.4`. No migration is required.

## 0.1.0-beta.4 (2026-10-14)

- The npm README title is now text instead of an image, so it stays readable when npm's theme toggle differs from the system color scheme.

The header matches the GitHub README: the current hook logo sits above the title, without a white panel. Runtime behavior, public APIs, dependencies, and database schema are unchanged from `0.1.0-beta.3`. No migration is required.

## 0.1.0-beta.3 (2026-10-12)

Documentation update. The documentation moves to [good-webhooks.dev](https://good-webhooks.dev). The npm README, the bundled Agent Skill, and the package `homepage` now link there, and the package lists npm keywords. The npm README is reorganized into numbered usage steps, a feature list, and a requirements table, with code that fits npm's page width. Links to `good-webhooks.vercel.app` from earlier versions redirect to the new domain.

Runtime behavior, public APIs, dependencies, and database schema are unchanged from `0.1.0-beta.2`. No migration is required.

## 0.1.0-beta.2 (2026-10-12)

**Schema upgrade required.** Storage moves to schema version `4`: both components now record their version in `webhook_schema_version`, keyed by component, so management changes can be detected and gated like delivery changes. No data table changes.

- Apply `getPostgresUpgrade({ from: 3 })` or `migrations/upgrades/004-all.sql` (or the per-component files for separate namespaces) with your migration runner before restarting on this version. Processes on `0.1.0-beta.1` keep working until they restart; a restarted old process fails at `check()`. See the [migrations guide](apps/docs/content/docs/operations/migrations.mdx#upgrades).
- `good-webhooks/migrations` adds `getPostgresUpgrade()`, `PostgresUpgradeOptions`, and `POSTGRES_SCHEMA_VERSION`. Fresh-install SQL creates the version table with `IF NOT EXISTS` so management and delivery can be installed separately into one namespace.
- `check()` messages name the SQL to apply next, and `createPostgresManagement().check()` now verifies the recorded version.
- CI rehearses the upgrade against the previously published package with a pending backlog (`pnpm test:compat`). [ADR 0011](docs/adr/0011-versioned-schema-upgrades.md) records the contract.
- New documentation: [failure behavior](apps/docs/content/docs/operations/failure-behavior.mdx) states what crashes, dropped connections, hanging receivers, and signals do to in-flight work, each claim mapped to its test; [performance](apps/docs/content/docs/operations/performance.mdx) publishes a fixed benchmark profile and its measured numbers.
- New rehearsals in CI: `pnpm test:chaos` kills worker connections, holds an exclusive lock past the statement timeout, and uses failing and hanging receivers; `pnpm benchmark` runs the published profile as a smoke check.

## 0.1.0-beta.1 (2026-10-12)

First beta. The public API is frozen: from this release, a breaking change is allowed only to fix a correctness or security defect, is labelled **Breaking** in the changelog, and ships with a migration note. The [stability policy](apps/docs/content/docs/operations/compatibility.mdx) defines the public surface, what counts as breaking, and the fix policy for `0.1.0` and later. Progress toward the stable release is tracked in [issue #22](https://github.com/pplytas/good-webhooks/issues/22).

The npm dist-tag moves from `alpha` to `beta`; install with `good-webhooks@beta` or an exact version. Runtime behavior, public APIs, dependencies, and database schema are unchanged from `0.1.0-alpha.4`. No migration is required.

## 0.1.0-alpha.4 (2026-10-09)

Agent and documentation update. The package now ships an [Agent Skill](https://agentskills.io) in `skills/good-webhooks/` with setup steps, code templates, and common-mistake rules that match the installed version. Install it with `npx skills add pplytas/good-webhooks`, or copy it from `node_modules/good-webhooks/skills/`. The npm README is rewritten around one example.

Runtime behavior, public APIs, dependencies, and database schema are unchanged from `0.1.0-alpha.3`. No migration is required.

## 0.1.0-alpha.3 (2026-10-08)

Fix delivery-history ordering and cursor pagination. `deliveries.list()` now sorts by the numeric delivery ID instead of its text representation. Previously, IDs such as `9` appeared before `43`, and cursor pages could skip deliveries across digit boundaries.

Public APIs, dependencies, and database schema are unchanged. No migration is required. This corrects history inspection only; webhook dispatch still has no ordering guarantee.

## 0.1.0-alpha.2 (2026-10-08)

Release-engineering update for GitHub Actions trusted publishing and npm provenance. Runtime behavior, public APIs, dependencies, and database schema are unchanged from `0.1.0-alpha.1`.

## 0.1.0-alpha.1 (2026-10-08)

First public alpha release for embedded TypeScript webhook management and delivery.

- Manage endpoints through a Better Auth plugin or a standalone PostgreSQL provider. Connect either provider to an application-owned sender or the built-in delivery engine.
- Validate typed event payloads with Standard Schema, publish idempotently, and commit publication with business writes on the same PostgreSQL transaction.
- Dispatch signed Standard Webhooks requests with durable retries, attempt history, and explicit replay. Receivers verify signatures and deduplicate event IDs.
- Run a continuous worker or one bounded batch with graceful shutdown. Schedule retention cleanup explicitly.
- Install management and delivery storage separately. Applications own migrations, database connections, encryption keys, worker processes, and authorization policy.

The release requires Node.js 24 or later and TypeScript 5.9.3 or later for TypeScript consumers. PostgreSQL components support PostgreSQL 16 and 17. Better Auth management supports `>=1.7.7 <1.8.0`, tested with 1.7.7.

This alpha has no delivery ordering or exactly-once guarantee. The current delivery schema is version 3. The supplied SQL initializes fresh storage and does not upgrade unpublished prototype installations. See the [compatibility policy](apps/docs/content/docs/operations/compatibility.mdx) and [migration guide](apps/docs/content/docs/operations/migrations.mdx).
