# Good Webhooks documentation

This private workspace is the public documentation site, a Next.js app deployed on Vercel. Fumadocs supplies the layout, neutral theme, navigation, code blocks, and search. Pages and Markdown exports are prerendered at build time; only search and `proxy.ts` run per request.

From the repository root:

```sh
pnpm dev
pnpm build
pnpm --filter @good-webhooks/docs preview
```

`preview` runs `next start` on the production build at `http://localhost:3000`. Set `PORT` to use another port. The site needs no auth instance or database.

## Structure

- `app/(home)/page.tsx` is the landing page at `/`.
- `app/docs/[[...slug]]/page.tsx` renders `content/docs/` under `/docs`. `content/docs/index.mdx` is the introduction.
- `app/llms.txt`, `app/llms-full.txt`, and `app/llms.mdx/docs/[[...slug]]` export Markdown for AI tools. Every page is also Markdown at its own URL plus `.md` (`/docs/quick-start.md`, `/docs.md` for the introduction) through the rewrites in `next.config.mjs`. `proxy.ts` serves the same Markdown at the page URL itself when a request prefers `text/markdown`. `lib/llms.ts` builds the sectioned `llms.txt` index from the sidebar and rewrites docs links in exports to absolute Markdown URLs. Each docs page links to its `.md` export through the copy and open actions and a `rel="alternate"` link. `app/sitemap.ts` and `app/robots.ts` export `sitemap.xml` and `robots.txt`.
- `lib/site.ts` reads the package version for the sidebar badge and npm link. `lib/layout.shared.tsx` holds the shared navigation.

## Authoring

Write public pages in `content/docs/`. Each page needs `title` and `description` frontmatter. The root `content/docs/meta.json` lists every page in sidebar order; `---Group---` entries are section labels and `[Title](url)` entries are external links.

Pages follow the same shape: a one-paragraph lead, code before caveats, `Steps` for tutorials, `Tabs` for alternative APIs, `Callout` for things that bite, and a `Cards` block of next steps at the end. Install commands use the `package-install` code language, which renders npm, pnpm, yarn, and bun tabs.

The shared MDX components include `Accordion`, `Accordions`, `Callout`, `Card`, `Cards`, `Flow`, `FlowStep`, `Step`, `Steps`, `Tab`, `Tabs`, and `TypeTable`.

Use `Flow` for a sequence of stages instead of an image or ASCII diagram. It renders as an ordered list, so screen readers and agents read the same steps:

```mdx
<Flow title="The life of one event">
  <FlowStep title="Publish" actor="your app">
    `publish()` stores the event.
  </FlowStep>
  <FlowStep title="Deliver" actor="worker">
    The worker signs and sends it.
  </FlowStep>
</Flow>
```

Page layers: the introduction orients evaluators, the quick start gets a first success in one file, guides cover one task each, and reference pages hold the full contracts. Every code block should run as printed: include its imports, or say which module it comes from.

`lib/markdown-export.ts` turns these components into plain Markdown for the `.md` exports and `llms-full.txt`: tab labels, card links, callout titles, flow steps, and type tables. Add a case there when you add a component whose content would otherwise be lost.

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

The checks compile the app and reference examples, verify that generated tables track their TypeScript inputs, and build every page and Markdown export. `check:links` starts `next start` on a free port, crawls every sitemap page and every Markdown export listed in `llms.txt`, and validates links, assets, fragments, content negotiation, and search. The browser smoke check starts its own server the same way. It verifies the landing page, docs routes, a Markdown export, a generated table, search navigation, the theme switch, and mobile navigation. Install Chromium once locally; CI installs it with system dependencies. Use `preview` for visual review and code copying.
