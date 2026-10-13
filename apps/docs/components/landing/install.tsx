'use client'

import { useState } from 'react'
import { CopyButton } from '@/components/copy-button'
import { quickStartPrompt } from '@/lib/prompts'

/**
 * Package manager tabs, then the two agent entry points, after Vite's package manager tabs
 * and Better Auth's CLI / Prompt / Skills strip. Switching is instant: people flip these
 * several times while reading.
 */
const options = [
  { label: 'npm', text: 'npm install good-webhooks@beta', command: true },
  { label: 'pnpm', text: 'pnpm add good-webhooks@beta', command: true },
  { label: 'bun', text: 'bun add good-webhooks@beta', command: true },
  { label: 'Skill', text: 'npx skills add pplytas/good-webhooks', command: true },
  { label: 'Prompt', text: quickStartPrompt, command: false },
] as const

export function Install() {
  const [selected, setSelected] = useState(0)
  const option = options[selected]!
  return (
    <div className="max-w-md overflow-hidden rounded-xl border bg-fd-card">
      <div role="tablist" aria-label="Install" className="flex gap-1 border-b px-2 pt-1.5">
        {options.map((item, index) => (
          <button
            key={item.label}
            type="button"
            role="tab"
            aria-selected={index === selected}
            onClick={() => setSelected(index)}
            className="-mb-px rounded-t-sm border-b border-transparent px-2 pb-1.5 font-mono text-xs text-fd-muted-foreground transition-colors hover:text-fd-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-fd-ring aria-selected:border-fd-primary aria-selected:text-fd-foreground"
          >
            {item.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="flex min-h-14 items-start gap-2 py-2.5 pl-4 pr-2.5">
        <p className="flex-1 pt-1 font-mono text-[13px] leading-relaxed">
          {option.command ? <span className="select-none text-fd-muted-foreground">$ </span> : null}
          {option.text}
        </p>
        <CopyButton text={option.text} label={`Copy ${option.label.toLowerCase()}`} />
      </div>
    </div>
  )
}
