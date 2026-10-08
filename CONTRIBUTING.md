# Contribute to Good Webhooks

Use Node.js 24 or later and PostgreSQL 16 or later. The repository pins pnpm 12.10.1 in `package.json`. Clone the repository, enable Corepack if you use it, then run `pnpm install --frozen-lockfile`.

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
pnpm check:package
pnpm format:check
pnpm test
pnpm test:package
```

The test suite applies its own schema. Default PostgreSQL tables use the `webhook_` prefix in `public`; schema-isolation tests also create custom schemas. Runtime constructors and `getPostgresMigration` must use the same schema name. Keep the shipped SQL files aligned with the generator's `public` output. For database-free tests, run `pnpm test:unit`. To format changes, run `pnpm format`.

Follow the [README example](README.md#try-the-example) to verify delivery, retry, replay, and durable receiver deduplication. Apply its separate receiver SQL before running the demo.

CI runs the full suite and demo on PostgreSQL 16 and 17 with Node.js 24. It also installs the package archive and checks all entry points through ESM and CommonJS, standalone installation without Better Auth, the exported migrations, and public TypeScript declarations. It does not publish to npm. The root and docs manifests are private. Keep the library private until a separate publication decision.

`pnpm test:package` checks TypeScript 5.9.3 and the repository compiler with NodeNext and Bundler resolution. Standalone consumers check all declarations; Better Auth consumers retain inference checks with `skipLibCheck` for upstream types.

`pnpm test:operations` requires an explicit `TEST_DATABASE_URL` for a disposable PostgreSQL database. It creates and removes a unique schema, drains a bounded backlog, forces receiver timeouts, kills a worker process, and verifies recovery with a replacement worker. It checks durable completion and receiver deduplication, not production capacity. CI runs this on PostgreSQL 16 and 17.

See the [release guide](docs/releasing.md) for candidate verification, npm ownership, and trusted publishing setup. The release workflow defaults to a dry run. Publication requires a separate decision and never runs on an ordinary merge.

The fresh-install SQL is defined in `packages/good-webhooks/src/migrations.ts`. After editing it, run `pnpm migrations:generate` to refresh the three default SQL files. Tests verify that the shipped files match the generator. Runtime queries and migration generation share the table names in `packages/good-webhooks/src/postgres-schema.ts`.

## Verify Better Auth adapters

`pnpm test:adapters` runs the [database matrix](docs/better-auth-database-compatibility.md). It requires local disposable server instances and creates its own temporary databases. You can select profiles, for example `pnpm test:adapters libsql,d1` without database servers or `pnpm test:adapters postgres,drizzle,prisma` with PostgreSQL. The CI adapter job supplies PostgreSQL, MySQL, MongoDB, and SQL Server services.

## Work on documentation

Public documentation lives in `apps/docs/content/docs`. Engineering records stay in root `docs`, and the public package lives in `packages/good-webhooks`. Root commands select the right workspace; package-specific scripts run from the package directory.

```sh
pnpm dev
pnpm check
pnpm build
pnpm --filter @good-webhooks/docs check:links
pnpm --filter @good-webhooks/docs preview
```

The docs build consumes the local package's public declarations and checked example source. Keep server/database dependencies out of client components. Run browser checks against the exported site, including direct links, search, copy buttons, keyboard navigation, mobile navigation, and both color themes. Deployment is separate from the build.

`pnpm-workspace.yaml` explicitly allows the dependency build scripts needed by Prisma, esbuild, and workerd. Review new lifecycle scripts when changing dependencies; keep the default isolated dependency layout. Commit the root `pnpm-lock.yaml` and verify `pnpm install --frozen-lockfile` succeeds.

## Propose a change

Open a focused pull request against `main`. Describe the concrete problem, resulting behavior, and verification. Include a regression test when behavior changes.

Keep the core independent of application identity models and frameworks. For changes to the public API, signing format, database schema, or delivery guarantees, open an issue first to align on the contract. Existing [design decisions](docs/adr/) and the [v0 scope](docs/v0-plan.md) describe those contracts.

Use issues for reproducible bugs and feature proposals. Report vulnerabilities privately through the [security policy](SECURITY.md).
