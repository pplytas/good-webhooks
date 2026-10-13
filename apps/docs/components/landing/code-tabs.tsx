'use client'

import type { ReactNode } from 'react'
import { useState } from 'react'

/**
 * A row of chips that picks one of several server-highlighted code blocks, after the framework
 * pickers on the Resend and AI SDK homes. Every panel is rendered and only hidden, so the
 * highlighting arrives with the page and switching is instant.
 */
export function CodeTabs({ tabs }: { tabs: { label: string; content: ReactNode }[] }) {
  const [selected, setSelected] = useState(0)
  return (
    <div>
      <div role="tablist" aria-label="Framework" className="mb-3 flex flex-wrap gap-1.5">
        {tabs.map((tab, index) => (
          <button
            key={tab.label}
            type="button"
            role="tab"
            aria-selected={index === selected}
            onClick={() => setSelected(index)}
            className="pressable rounded-full border px-3 py-1 text-xs font-medium text-fd-muted-foreground transition-[color,background-color,transform] duration-150 ease-out hover:text-fd-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring aria-selected:border-transparent aria-selected:bg-fd-foreground aria-selected:text-fd-background"
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab, index) => (
        <div key={tab.label} role="tabpanel" hidden={index !== selected} className="min-w-0">
          {tab.content}
        </div>
      ))}
    </div>
  )
}
