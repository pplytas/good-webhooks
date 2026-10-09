import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { site } from '@/lib/site'
import { Logo } from '@/components/logo'

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="inline-flex items-center gap-2 font-semibold">
          <Logo className="size-5" />
          {site.name}
        </span>
      ),
      url: '/',
    },
    githubUrl: site.githubUrl,
    links: [
      { text: 'Docs', url: '/docs', active: 'nested-url' },
      { text: 'Examples', url: '/docs/examples', active: 'url' },
      { text: 'Reference', url: '/docs/reference', active: 'nested-url' },
      { text: 'Changelog', url: site.changelogUrl, external: true },
    ],
  }
}
