import { Fragment } from 'react'
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { site } from '@/lib/site'
import { Logo } from '@/components/logo'

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="inline-flex items-center gap-2.5 whitespace-nowrap text-[13px] font-semibold uppercase tracking-[0.08em]">
          <Logo className="size-[18px]" />
          {site.name}
        </span>
      ),
      url: '/',
    },
    githubUrl: site.githubUrl,
    links: [
      // Header links are for separate workspaces. Sections of the docs live in the sidebar.
      { text: 'Documentation', url: '/docs', active: 'nested-url' },
      {
        // Fumadocs renders icon and text side by side in an array, so both need keys.
        text: (
          <span key="text" className="inline-flex items-center gap-1 lg:me-4">
            Changelog
            <ExternalIcon />
            <span className="sr-only">(opens in a new tab)</span>
          </span>
        ),
        url: site.changelogUrl,
        external: true,
        // The trailing icon above marks it everywhere; this stops the sidebar adding a leading one.
        // lg:me-4 above matches the 24px gap between header links before the GitHub icon.
        icon: <Fragment key="icon" />,
      },
    ],
  }
}

function ExternalIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5 opacity-70"
    >
      <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  )
}
