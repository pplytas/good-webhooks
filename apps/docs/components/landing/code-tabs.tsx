'use client'

import type { ReactNode } from 'react'
import { useState } from 'react'

/**
 * A heading row with a label on the left and chips on the right that pick one of several
 * server-highlighted code blocks. Every panel is rendered and only hidden, so the highlighting
 * arrives with the page and switching is instant.
 */
export function CodeTabs({
  label,
  tabs,
}: {
  label?: ReactNode
  tabs: { label: string; content: ReactNode }[]
}) {
  const [selected, setSelected] = useState(0)
  return (
    <div className="flex flex-1 flex-col">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        {label}
        <div role="tablist" aria-label="Framework" className="flex flex-wrap gap-1">
          {tabs.map((tab, index) => (
            <button
              key={tab.label}
              type="button"
              role="tab"
              aria-selected={index === selected}
              onClick={() => setSelected(index)}
              className="pressable border border-transparent px-2.5 py-1 text-xs font-medium text-fd-muted-foreground transition-[color,background-color,border-color,transform] duration-150 ease-out hover:text-fd-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring aria-selected:border-fd-border aria-selected:bg-fd-secondary aria-selected:text-fd-foreground"
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      {tabs.map((tab, index) => (
        <div
          key={tab.label}
          role="tabpanel"
          hidden={index !== selected}
          className="flex min-w-0 flex-1 flex-col *:flex-1"
        >
          {tab.content}
        </div>
      ))}
    </div>
  )
}
