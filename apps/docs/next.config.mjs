import { createMDX } from 'fumadocs-mdx/next'

const withMDX = createMDX()

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
