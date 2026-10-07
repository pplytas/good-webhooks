# Contribute to Good Webhooks

Use Node.js 24 or later and PostgreSQL 16 or later. Clone the repository, then run `npm ci`.

## Run checks

Create a dedicated disposable database. The integration tests reset webhook tables and test schemas, hold locks, and terminate their own database connections. Never use an application database for tests.

```sh
docker run --name good-webhooks-tests \
	-e POSTGRES_PASSWORD=webhooks_dev_only \
	-e POSTGRES_DB=webhooks \
	-p 127.0.0.1:55439:5432 \
	-d postgres:16
```

Wait for PostgreSQL to accept connections, then run:

```sh
export TEST_DATABASE_URL='postgres://postgres:webhooks_dev_only@127.0.0.1:55439/webhooks'
npm run check
npm run format:check
npm test
npm run test:package
```

The test suite applies its own schema. Default PostgreSQL tables use the `webhook_` prefix in `public`; schema-isolation tests also create custom schemas. Runtime constructors and `getPostgresMigration` must use the same schema name. Keep the shipped SQL files aligned with the generator's `public` output. For database-free tests, run `npm run test:unit`. To format changes, run `npm run format`.

Follow the [README example](README.md#try-the-example) to verify delivery, retry, replay, and durable receiver deduplication. Apply its separate receiver SQL before running the demo.

CI runs the full suite and demo on PostgreSQL 16 and 17 with Node.js 24. It also installs the package archive and checks all entry points through ESM and CommonJS, standalone installation without Better Auth, and the exported migrations. It does not publish to npm.

The fresh-install SQL is defined in `src/migrations.ts`. After editing it, run `npm run migrations:generate` to refresh the three default SQL files. Tests verify that the shipped files match the generator. Runtime queries and migration generation share the table names in `src/postgres-schema.ts`.

## Verify Better Auth adapters

`npm run test:adapters` runs the [database matrix](docs/better-auth-database-compatibility.md). It requires local disposable server instances and creates its own temporary databases. You can select profiles, for example `npm run test:adapters -- libsql,d1` without database servers or `npm run test:adapters -- postgres,drizzle,prisma` with PostgreSQL. The CI adapter job supplies PostgreSQL, MySQL, MongoDB, and SQL Server services.

## Propose a change

Open a focused pull request against `main`. Describe the concrete problem, resulting behavior, and verification. Include a regression test when behavior changes.

Keep the core independent of application identity models and frameworks. For changes to the public API, signing format, database schema, or delivery guarantees, open an issue first to align on the contract. Existing [design decisions](docs/adr/) and the [v0 scope](docs/v0-plan.md) describe those contracts.

Use issues for reproducible bugs and feature proposals. Report vulnerabilities privately through the [security policy](SECURITY.md).
