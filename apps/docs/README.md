# Good Webhooks documentation

This private workspace builds the public documentation as static HTML. Fumadocs supplies the layout, neutral theme, navigation, code blocks, and search interface.

From the repository root:

```sh
pnpm dev
pnpm build
pnpm --filter @good-webhooks/docs preview
```

The preview serves `out/` on `http://localhost:3000`. Set `PORT` to use another port. The exported site requires no Node.js server, auth instance, or database.

## Authoring

Write public pages in `content/docs/`. Each page needs `title` and `description` frontmatter. Use `meta.json` files to order navigation. Public URLs start at `/`; `content/docs/index.mdx` is the overview.

The shared MDX components include `Callout`, `Card`, `Cards`, `Step`, `Steps`, `Tab`, `Tabs`, and `TypeTable`.

Include checked library examples as text at build time:

```mdx
<include cwd lang="ts" meta='title="examples/basic/demo.ts"'>
  ../../packages/good-webhooks/examples/basic/demo.ts
</include>
```

Reference pages can generate a table from the public declaration wrappers in `content/reference-types.ts`:

```mdx
<auto-type-table path="../../reference-types.ts" name="VerifyOptions" />
```

The generator runs during MDX compilation. It registers the wrapper and resolved declarations as bundler dependencies, then closes its native TypeScript process after each table. It does not persist a table cache. Library builds must precede docs checks and builds so imported declarations are current.

Keep executable library imports out of app components. The site includes examples as text; `examples/typed-api.ts` separately compiles representative generic and Better Auth calls against public package exports. It never executes them.

## Verification

```sh
pnpm --filter good-webhooks build
pnpm --filter @good-webhooks/docs check
pnpm --filter @good-webhooks/docs build
pnpm --filter @good-webhooks/docs check:links
pnpm --filter @good-webhooks/docs exec playwright install chromium
pnpm --filter @good-webhooks/docs check:browser
```

The checks compile the app and reference examples, verify that generated tables track their TypeScript inputs, export every page and the search index, and validate local links, assets, and fragment targets. The browser smoke check starts its own static preview on an available port. It verifies routes, a generated table, search navigation, the theme switch, and mobile navigation. Install Chromium once locally; CI installs it with system dependencies. Use the interactive preview for visual review and code copying.
