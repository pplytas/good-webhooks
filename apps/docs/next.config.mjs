import { createMDX } from 'fumadocs-mdx/next'

const withMDX = createMDX()

// Pages merged into others. Old links, including their `.md` exports, keep working.
const movedPages = {
  '/docs/better-auth/database-adapters': '/docs/better-auth#supported-databases',
  '/docs/operations/failure-behavior': '/docs/operations/workers#what-failures-do',
  '/docs/operations/retention': '/docs/operations/retries-and-replay#clean-up-history',
  '/docs/reference/better-auth-client': '/docs/reference/better-auth#client-plugin',
}

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  async redirects() {
    return [
      // The old production host. Published package READMEs and skills link here, so this stays.
      // MCP clients POST and may not follow redirects, so the MCP endpoint keeps answering.
      {
        source: '/:path((?!api/mcp$).*)',
        has: [{ type: 'host', value: 'good-webhooks.vercel.app' }],
        destination: 'https://good-webhooks.dev/:path',
        permanent: true,
      },
      // The home card's old URL, still referenced by pages shared before it was versioned.
      { source: '/opengraph-image', destination: '/og/image.png', permanent: true },
      ...Object.entries(movedPages).flatMap(([source, destination]) => [
        { source, destination, permanent: true },
        { source: `${source}.md`, destination: `${destination.split('#')[0]}.md`, permanent: true },
      ]),
    ]
  },
  async rewrites() {
    return [
      // Every docs page is also Markdown at its own URL plus `.md`.
      { source: '/docs.md', destination: '/llms.mdx/docs' },
      { source: '/docs/:path+.md', destination: '/llms.mdx/docs/:path+' },
    ]
  },
}

export default withMDX(config)
