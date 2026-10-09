import type { ReactNode } from 'react'
import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import { source } from '@/lib/source'
import { baseOptions } from '@/lib/layout.shared'
import { VersionBadge } from '@/components/version-badge'
import { SidebarSeparator } from '@/components/sidebar-separator'

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      {...baseOptions()}
      tree={source.getPageTree()}
      sidebar={{
        banner: <VersionBadge />,
        defaultOpenLevel: 0,
        components: { Separator: SidebarSeparator },
      }}
    >
      {children}
    </DocsLayout>
  )
}
