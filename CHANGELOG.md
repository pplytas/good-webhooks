# Changelog

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
