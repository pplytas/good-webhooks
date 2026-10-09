# Good Webhooks

Build webhook delivery into your TypeScript application.

Good Webhooks is an embedded TypeScript package for outbound webhooks. Use Better Auth for authenticated endpoint management, connect your own sender, or add the PostgreSQL publisher and worker.

Good Webhooks is in alpha. Node.js 24 or later is required. The package ships ESM; Node.js 24 also supports loading this build with CommonJS `require()`.

| Setup                                         | Entry points                                                    | Storage                                            |
| --------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------- |
| Better Auth management with your sender       | `good-webhooks/better-auth`, `good-webhooks/better-auth/client` | Better Auth adapter                                |
| Better Auth management with built-in delivery | Above plus `good-webhooks/delivery`                             | Better Auth adapter and PostgreSQL delivery tables |
| Standalone management and delivery            | `good-webhooks`                                                 | PostgreSQL management and delivery tables          |
| Standalone management with your sender        | `good-webhooks/management/postgres`                             | PostgreSQL management tables                       |

PostgreSQL setups require version 16 or later. Better Auth is an optional peer; standalone imports do not require it. The supported Better Auth range is `>=1.7.7 <1.8.0`, tested with 1.7.7.

TypeScript consumers need TypeScript 5.9.3 or later, with NodeNext or Bundler resolution. Better Auth consumers use `skipLibCheck` for upstream declarations. See [compatibility and upgrades](https://good-webhooks.vercel.app/docs/operations/compatibility).

## Documentation

Read the [documentation](https://good-webhooks.vercel.app). The repository contains its [source](https://github.com/pplytas/good-webhooks/tree/main/apps/docs/content/docs). Run `pnpm dev` from a repository checkout to preview changes locally.

- [Install Good Webhooks](https://good-webhooks.vercel.app/docs/installation)
- [Better Auth quick start](https://good-webhooks.vercel.app/docs/better-auth/quick-start)
- [Quick start](https://good-webhooks.vercel.app/docs/quick-start)
- [Connect a custom sender](https://good-webhooks.vercel.app/docs/guides/custom-senders)
- [API reference](https://good-webhooks.vercel.app/docs/reference)

The [standalone example](examples/basic/demo.ts) exercises rollback, signed delivery, retry, replay, and receiver deduplication. The [repository README](https://github.com/pplytas/good-webhooks#readme) includes its database setup.

## Install

Install the alpha release in your application:

```sh
npm install good-webhooks@alpha
```

## Install from a checkout

Run these commands at the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --dir packages/good-webhooks pack
```

Then install the archive in your application:

```sh
npm install /absolute/path/to/good-webhooks-0.1.0-alpha.3.tgz
```

Your application supplies its database driver and payload validators. Apply the appropriate initial migration before using the PostgreSQL provider or delivery engine. Better Auth management uses Better Auth's schema workflow instead. The migration generator is available at `good-webhooks/migrations`.

Delivery can occur more than once and has no ordering guarantee. Receivers must verify signatures and deduplicate event IDs. The dedicated `good-webhooks/verify` entrypoint provides signature verification and typed payload parsing.

Licensed under [MIT](LICENSE). See the repository [contribution guide](https://github.com/pplytas/good-webhooks/blob/main/CONTRIBUTING.md) and [security policy](https://github.com/pplytas/good-webhooks/blob/main/SECURITY.md).
