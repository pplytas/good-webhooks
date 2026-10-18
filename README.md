<p align="center">
  <img alt="" src="https://good-webhooks.dev/readme/mark-square.png" width="56" height="56" />
</p>

<h1 align="center">Good Webhooks</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/good-webhooks"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/npm/v/good-webhooks.svg?size=xs&mode=dark&font=geist" /><img alt="npm version" src="https://shieldcn.dev/npm/v/good-webhooks.svg?size=xs&mode=light&font=geist" /></picture></a>
  <a href="https://www.npmjs.com/package/good-webhooks"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/npm/dw/good-webhooks.svg?variant=secondary&size=xs&mode=dark&font=geist" /><img alt="npm downloads" src="https://shieldcn.dev/npm/dw/good-webhooks.svg?variant=secondary&size=xs&mode=light&font=geist" /></picture></a>
  <a href="LICENSE"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/license/pplytas/good-webhooks.svg?variant=secondary&size=xs&mode=dark&font=geist" /><img alt="MIT license" src="https://shieldcn.dev/github/license/pplytas/good-webhooks.svg?variant=secondary&size=xs&mode=light&font=geist" /></picture></a>
  <a href="https://github.com/pplytas/good-webhooks/actions/workflows/ci.yml"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/ci/pplytas/good-webhooks.svg?workflow=ci.yml&branch=main&variant=secondary&size=xs&mode=dark&font=geist" /><img alt="CI status" src="https://shieldcn.dev/github/ci/pplytas/good-webhooks.svg?workflow=ci.yml&branch=main&variant=secondary&size=xs&mode=light&font=geist" /></picture></a>
</p>

<p align="center">
  Build webhook delivery into your TypeScript application.
</p>

<p align="center">
  <a href="https://good-webhooks.dev/docs"><b>Documentation</b></a> ·
  <a href="https://good-webhooks.dev/docs/quick-start">Quick start</a> ·
  <a href="https://good-webhooks.dev/docs/reference">API reference</a> ·
  <a href="https://good-webhooks.dev/docs/ai">For AI agents</a>
</p>

You publish typed events. Good Webhooks stores them in your PostgreSQL database, and a worker you run delivers signed [Standard Webhooks](https://www.standardwebhooks.com) requests, retries failures, and records every attempt. Receivers verify a request with one function. Endpoint management works standalone, through the Better Auth plugin, or with your own sender.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://good-webhooks.dev/readme/pipeline-dark.png" />
    <img alt="Your app calls publish(), which records the event and one delivery per endpoint in PostgreSQL. A worker signs, sends, retries, and records each delivery. The receiver calls parseWebhook() to verify it and get a typed event." src="https://good-webhooks.dev/readme/pipeline-light.png" />
  </picture>
</p>

> **Stable API.** From `0.1.0` the public API and upgrade path follow the [stability policy](https://good-webhooks.dev/docs/operations/compatibility#stability-policy). Throughput beyond the [measured profile](https://good-webhooks.dev/docs/operations/performance) is not yet verified.

## Install

```sh
npm install good-webhooks pg zod
```

Requires Node.js 24 or later. Built-in delivery and standalone management need PostgreSQL 16, 17, or 18. Better Auth management uses your existing Better Auth database adapter. See [installation](https://good-webhooks.dev/docs/installation) for each setup's dependencies and the [compatibility policy](https://good-webhooks.dev/docs/operations/compatibility) for tested versions.

| You want                                     | Start with                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| Everything on PostgreSQL                     | [Quick start](https://good-webhooks.dev/docs/quick-start)              |
| Signed-in users managing their own endpoints | [Better Auth plugin](https://good-webhooks.dev/docs/better-auth)       |
| Better Auth endpoints with built-in delivery | [Add delivery](https://good-webhooks.dev/docs/better-auth/delivery)    |
| Endpoint management for your own sender      | [Custom senders](https://good-webhooks.dev/docs/guides/custom-senders) |
| Only receiving webhooks                      | [Receive webhooks](https://good-webhooks.dev/docs/guides/receive)      |

The [package README](packages/good-webhooks/README.md) walks through publishing, running a worker, and verifying on the receiving side.

## Run complete applications

Two interactive examples show the full path from a business action to a verified webhook and receiver outcome:

- [Order fulfillment](examples/order-fulfillment): place a shop order, send it to a warehouse, simulate an outage, and replay a delivery without creating a second shipment.
- [Better Auth billing](examples/better-auth-billing): sign in, manage personal endpoints, publish invoice events, and inspect delivery attempts within the signed-in user's scope.

Each example has its own npm lockfile, PostgreSQL setup, browser UI, receiver, and separate worker process. Both install `good-webhooks@0.2.1` from npm and can run together. Follow the [examples guide](examples/README.md) to get started.

## Work on the repository

| Directory                                          | Contents                                                     |
| -------------------------------------------------- | ------------------------------------------------------------ |
| [`packages/good-webhooks`](packages/good-webhooks) | Public package source, examples, migrations, and tests       |
| [`apps/docs`](apps/docs)                           | Fumadocs site behind good-webhooks.dev                       |
| [`examples`](examples)                             | Complete applications that install the published npm package |
| [`docs`](docs)                                     | Engineering plans and architecture decisions                 |

Use Node.js 24 and the repository's pinned pnpm version, 12.10.1. If Corepack is available, enable its shims with `corepack enable`; otherwise install that pnpm version using the [pnpm installation instructions](https://pnpm.io/installation).

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://localhost:3000` for the documentation site. To build, check links, and run the production build:

```sh
pnpm build
pnpm --filter @good-webhooks/docs check:links
pnpm --filter @good-webhooks/docs preview
```

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
npm install /absolute/path/to/packages/good-webhooks/good-webhooks-0.3.0.tgz
```

`pnpm test:package` verifies the archive with fresh npm consumers, both with and without Better Auth, including the published declarations and SQL exports. Registry publication is a separate release step.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes. Maintainers use the [release guide](docs/releasing.md) to verify a candidate before publishing. Report vulnerabilities through the [security policy](SECURITY.md). Licensed under [MIT](LICENSE).
