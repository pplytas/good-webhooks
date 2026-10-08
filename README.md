# Good Webhooks

Build webhook delivery into your TypeScript application.

[![CI](https://github.com/pplytas/good-webhooks/actions/workflows/ci.yml/badge.svg)](https://github.com/pplytas/good-webhooks/actions/workflows/ci.yml)

Good Webhooks is an embedded TypeScript package for outbound webhooks. Manage endpoints through Better Auth, connect your own sender, or use the PostgreSQL publisher and worker. Standalone PostgreSQL management is also available.

This is an unpublished v0. The package requires Node.js 24 or later. The built-in delivery engine and standalone management provider require PostgreSQL 16 or later. Better Auth management uses the host's supported database adapter.

TypeScript consumers need TypeScript 5.9.3 or later. Read the [compatibility policy](apps/docs/content/docs/operations/compatibility.mdx) for tested configurations and alpha upgrades.

| Setup                                              | Start here                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Better Auth endpoint management                    | [Create your first endpoint](apps/docs/content/docs/better-auth/first-endpoint.mdx)  |
| Better Auth management with Good Webhooks delivery | [Add delivery](apps/docs/content/docs/better-auth/add-delivery.mdx)                  |
| Standalone management and delivery                 | [Send your first webhook](apps/docs/content/docs/getting-started/first-delivery.mdx) |
| Management with your own sender                    | [Custom senders](apps/docs/content/docs/management/custom-senders.mdx)               |

See the [documentation overview](apps/docs/content/docs/index.mdx) for guides, concepts, operations, and API reference. Preview the rendered site locally with the commands below.

## Work on the repository

Use Node.js 24 and the repository's pinned pnpm version, 12.10.1. If Corepack is available, enable its shims with `corepack enable`; otherwise install that pnpm version using the [pnpm installation instructions](https://pnpm.io/installation).

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://localhost:3000`. The documentation uses stock Fumadocs layouts and exports a static site. To build and preview the export:

```sh
pnpm build
pnpm --filter @good-webhooks/docs check:links
pnpm --filter @good-webhooks/docs preview
```

| Directory                                          | Contents                                                |
| -------------------------------------------------- | ------------------------------------------------------- |
| [`packages/good-webhooks`](packages/good-webhooks) | Public package source, examples, migrations, and tests  |
| [`apps/docs`](apps/docs)                           | Private Fumadocs app and canonical public documentation |
| [`docs`](docs)                                     | Engineering plans and architecture decisions            |

Run `pnpm check`, `pnpm format:check`, and `pnpm test:unit` for checks without a PostgreSQL server. The [contribution guide](CONTRIBUTING.md) covers integration tests, adapter checks, and documentation verification.

## Try the example

The [standalone demo](packages/good-webhooks/examples/basic/demo.ts) demonstrates rollback, signed delivery, retry, replay, and durable receiver deduplication. Start a disposable database:

```sh
docker run --name good-webhooks-demo \
  -e POSTGRES_PASSWORD=webhooks_dev_only \
  -e POSTGRES_DB=webhooks \
  -p 127.0.0.1:55439:5432 \
  -d postgres:16
```

Wait until PostgreSQL accepts connections, then apply the migrations once:

```sh
export DATABASE_URL='postgres://postgres:webhooks_dev_only@127.0.0.1:55439/webhooks'
psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f packages/good-webhooks/migrations/001-initial.sql
psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f packages/good-webhooks/examples/basic/receiver.sql
pnpm example
```

The demo leaves event, attempt, and receiver history for inspection. Do not run the integration tests against this database; those tests reset their database tables.

## Install a local archive

```sh
pnpm --dir packages/good-webhooks pack
```

In your application, install the resulting archive using npm or your preferred package manager:

```sh
npm install /absolute/path/to/packages/good-webhooks/good-webhooks-0.1.0-alpha.1.tgz
```

Follow the [installation guide](apps/docs/content/docs/getting-started/installation.mdx) for the dependencies your chosen setup needs. `pnpm test:package` verifies the archive with fresh npm consumers, both with and without Better Auth, including the published declarations and SQL exports. Registry publication is a separate release step.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes. Maintainers use the [release guide](docs/releasing.md) to verify a candidate before publishing. Report vulnerabilities through the [security policy](SECURITY.md). Licensed under [MIT](LICENSE).
