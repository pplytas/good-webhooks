# Changelog

## 0.1.0-alpha.1 (2026-10-08)

First public alpha release for embedded TypeScript webhook management and delivery.

- Manage endpoints through a Better Auth plugin or a standalone PostgreSQL provider. Connect either provider to an application-owned sender or the built-in delivery engine.
- Validate typed event payloads with Standard Schema, publish idempotently, and commit publication with business writes on the same PostgreSQL transaction.
- Dispatch signed Standard Webhooks requests with durable retries, attempt history, and explicit replay. Receivers verify signatures and deduplicate event IDs.
- Run a continuous worker or one bounded batch with graceful shutdown. Schedule retention cleanup explicitly.
- Install management and delivery storage separately. Applications own migrations, database connections, encryption keys, worker processes, and authorization policy.

The release requires Node.js 24 or later and TypeScript 5.9.3 or later for TypeScript consumers. PostgreSQL components support PostgreSQL 16 and 17. Better Auth management supports `>=1.7.7 <1.8.0`, tested with 1.7.7.

This alpha has no delivery ordering or exactly-once guarantee. The current delivery schema is version 3. The supplied SQL initializes fresh storage and does not upgrade unpublished prototype installations. See the [compatibility policy](apps/docs/content/docs/operations/compatibility.mdx) and [migration guide](apps/docs/content/docs/operations/migrations.mdx).
