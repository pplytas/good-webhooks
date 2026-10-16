# Better Auth database compatibility

The public summary is in the [Better Auth plugin guide](../apps/docs/content/docs/better-auth/index.mdx#supported-databases). This page keeps the test matrix, storage internals, and upstream contracts for contributors. The baseline is Better Auth 1.7.7 on Node.js 24. CI repeats the matrix on the newest 1.7 and 1.8 releases, including 1.8 betas; upstream source links below point at 1.7.7.

## Verified profiles

Each profile runs against a real database, generates and applies the schema, renames the model and fields, and exercises the repository. No in-memory fake adapter is used.

| Database or adapter | Test profile                                         | ID modes               |
| ------------------- | ---------------------------------------------------- | ---------------------- |
| SQLite              | Node.js `DatabaseSync`                               | Default, serial, UUID  |
| PostgreSQL 16       | Native Kysely adapter                                | Default, serial, UUID  |
| MySQL 8.4           | Native Kysely adapter                                | Default, serial, UUID  |
| MongoDB 8           | Native MongoDB adapter, transactions disabled        | Default ObjectId, UUID |
| SQL Server 2022     | Native Kysely adapter, UTF8 collation                | Default, serial, UUID  |
| libSQL              | Local libSQL client through Kysely                   | Default, serial, UUID  |
| Cloudflare D1       | Local Miniflare/workerd binding                      | Default, serial, UUID  |
| Drizzle             | PostgreSQL, schema generation and `drizzle-kit push` | Default, serial, UUID  |
| Prisma              | PostgreSQL, schema generation and `db push`          | Default, serial, UUID  |

The matrix checks concurrent creates competing for the last endpoint slots, complete enumeration of 1,000 endpoints regardless of adapter page size, concurrent revision-guarded updates with one winner, atomic secret and expiry writes, deletion with slot reuse, 100 subscriptions of maximum-length names, and maximum-length Unicode scopes, URLs, and descriptions.

> **SQL Server needs a UTF-8 collation.** Better Auth generates `varchar` columns. A legacy non-UTF8 collation corrupts Unicode scope IDs, URLs, and descriptions. The matrix uses `Latin1_General_100_CI_AS_SC_UTF8`.

## Not covered

Bun's SQLite, hosted D1, remote Turso, MongoDB replica-set transactions, and Drizzle or Prisma on databases other than PostgreSQL have not been exercised. Passing the matrix is not a deployment or performance certification. Apply schema changes with your usual migration workflow before serving requests.

## How storage works

- **Slots.** Each live endpoint occupies one of 1,000 deterministic slots per scope. A unique index on `allocationKey` makes creation atomic, even under concurrent creators. Deletion releases the slot in the same conditional write and keeps a tombstone.
- **Scope digest.** Slot keys use a SHA-256 digest of the scope. Reads verify the full scope identity afterwards and fail closed on a mismatch. A case-insensitive database comparison is never treated as equality.
- **Batched lookup.** Recipient lookup reads 50 slot keys at a time, which avoids offset-pagination gaps under concurrent deletion and stays under D1's parameter limit. Any failed batch fails the lookup.
- **Guarded mutations.** Updates use Better Auth's `incrementOne` with a revision predicate. Retries are limited to uniqueness contention and known rollback errors; an ambiguous connection failure is returned rather than retried, because retrying could create a duplicate.
- **Subscription storage.** Two internal array fields hold up to 50 names each, so 100 subscriptions fit SQL Server's `varchar(8000)` array representation. This is a storage detail, not two public lists.

Removing the unique index silently breaks the per-scope limit. Runtime validation does not replace correct migrations.

## Run the matrix yourself

From the repository root:

```sh
pnpm --filter good-webhooks test:adapters libsql,d1
pnpm --filter good-webhooks test:adapters postgres,mysql,mongodb,mssql,drizzle,prisma
```

Server profiles read `BA_MATRIX_POSTGRES_URL`, `BA_MATRIX_MYSQL_URL`, `BA_MATRIX_MONGODB_URL`, and `BA_MATRIX_MSSQL_URL`, accept loopback hosts only, and create and drop a random database per run. See the [contribution guide](../CONTRIBUTING.md) for the local service setup.

## Upstream contracts

- [Adapter interface](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/core/src/db/adapter/index.ts): `incrementOne`, conditional predicates, normalized IDs.
- [SQL schema generation](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/better-auth/src/db/get-migration.ts): column types per provider.
- [MongoDB adapter](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/mongo-adapter/src/mongodb-adapter.ts), [Drizzle adapter](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/drizzle-adapter/src/drizzle-adapter.ts), [Prisma adapter](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/prisma-adapter/src/prisma-adapter.ts).
