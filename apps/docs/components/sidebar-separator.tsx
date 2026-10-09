'use client'

import type * as PageTree from 'fumadocs-core/page-tree'

export function SidebarSeparator({ item }: { item: PageTree.Separator }) {
  return (
    <p className="mb-1.5 mt-6 flex items-center gap-2 px-2 text-sm font-medium text-fd-foreground first:mt-0">
      {item.icon}
      {item.name}
    </p>
  )
}
