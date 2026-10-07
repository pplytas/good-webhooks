# Good Webhooks

Build webhook delivery into your TypeScript application.

Good Webhooks is an embedded TypeScript package for outbound webhooks. Use Better Auth for authenticated endpoint management, connect your own sender, or add the PostgreSQL publisher and worker.

This is an unpublished v0. Use a local archive until the first registry release. Node.js 24 or later is required. The package ships ESM; Node.js 24 also supports loading this build with CommonJS `require()`.

| Setup                                         | Entry points                                                    | Storage                                            |
| --------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------- |
| Better Auth management with your sender       | `good-webhooks/better-auth`, `good-webhooks/better-auth/client` | Better Auth adapter                                |
| Better Auth management with built-in delivery | Above plus `good-webhooks/delivery`                             | Better Auth adapter and PostgreSQL delivery tables |
| Standalone management and delivery            | `good-webhooks`                                                 | PostgreSQL management and delivery tables          |
| Standalone management with your sender        | `good-webhooks/management/postgres`                             | PostgreSQL management tables                       |

PostgreSQL setups require version 16 or later. Better Auth is an optional peer; standalone imports do not require it. The supported Better Auth range is `>=1.7.7 <1.8.0`, tested with 1.7.7.

## Documentation

The repository contains the [documentation source](https://github.com/pplytas/good-webhooks/tree/main/apps/docs/content/docs). Run `pnpm dev` from a repository checkout to read the rendered site locally.

- [Install a local build](https://github.com/pplytas/good-webhooks/blob/main/apps/docs/content/docs/getting-started/installation.mdx)
- [Manage your first endpoint with Better Auth](https://github.com/pplytas/good-webhooks/blob/main/apps/docs/content/docs/better-auth/first-endpoint.mdx)
- [Send your first webhook](https://github.com/pplytas/good-webhooks/blob/main/apps/docs/content/docs/getting-started/first-delivery.mdx)
- [Connect a custom sender](https://github.com/pplytas/good-webhooks/blob/main/apps/docs/content/docs/management/custom-senders.mdx)
- [API reference](https://github.com/pplytas/good-webhooks/blob/main/apps/docs/content/docs/reference/index.mdx)

The [standalone example](examples/basic/demo.ts) exercises rollback, signed delivery, retry, replay, and receiver deduplication. The [repository README](https://github.com/pplytas/good-webhooks#readme) includes its database setup.

## Install from a checkout

Run these commands at the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --dir packages/good-webhooks pack
```

Then install the archive in your application:

```sh
npm install /absolute/path/to/good-webhooks-0.0.0.tgz
```

Your application supplies its database driver and payload validators. Apply the appropriate initial migration before using the PostgreSQL provider or delivery engine. Better Auth management uses Better Auth's schema workflow instead. The migration generator is available at `good-webhooks/migrations`.

Delivery can occur more than once and has no ordering guarantee. Receivers must verify signatures and deduplicate event IDs. The dedicated `good-webhooks/verify` entrypoint provides signature verification and typed payload parsing.

Licensed under [MIT](LICENSE). See the repository [contribution guide](https://github.com/pplytas/good-webhooks/blob/main/CONTRIBUTING.md) and [security policy](https://github.com/pplytas/good-webhooks/blob/main/SECURITY.md).
