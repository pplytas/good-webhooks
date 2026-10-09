import { createMDX } from 'fumadocs-mdx/next'

const withMDX = createMDX()

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  async rewrites() {
    return [
      // Every docs page is also Markdown at its own URL plus `.md`.
      { source: '/docs.md', destination: '/llms.mdx/docs' },
      { source: '/docs/:path+.md', destination: '/llms.mdx/docs/:path+' },
    ]
  },
}

export default withMDX(config)
