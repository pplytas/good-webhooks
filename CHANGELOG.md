# Changelog

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
