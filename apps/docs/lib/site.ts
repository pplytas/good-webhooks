import pkg from '../../../packages/good-webhooks/package.json' with { type: 'json' }

export const site = {
  name: 'Good Webhooks',
  description: 'Build webhook delivery into your TypeScript application.',
  url: 'https://good-webhooks.vercel.app',
  version: pkg.version,
  npmUrl: `https://www.npmjs.com/package/good-webhooks/v/${pkg.version}`,
  githubUrl: 'https://github.com/pplytas/good-webhooks',
  contentUrl: 'https://github.com/pplytas/good-webhooks/blob/main/apps/docs/content/docs',
  releasesUrl: 'https://github.com/pplytas/good-webhooks/releases',
  changelogUrl: 'https://github.com/pplytas/good-webhooks/blob/main/CHANGELOG.md',
} as const
