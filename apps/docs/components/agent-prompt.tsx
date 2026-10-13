import Link from 'next/link'
import { CopyButton } from '@/components/copy-button'
import { quickStartPrompt } from '@/lib/prompts'

/**
 * A copyable prompt for coding agents, after the boxes that open the Svix and Trigger.dev
 * quick starts. The Markdown export omits it: an agent reading the page needs no prompt to
 * read the page.
 */
export function AgentPrompt() {
  return (
    <aside className="not-prose my-6 rounded-xl first:mt-0 border bg-fd-card p-4">
      <p className="text-sm font-medium">Building with a coding agent?</p>
      <p className="mt-1 text-sm text-fd-muted-foreground">
        Paste this prompt. The{' '}
        <Link href="/docs/ai" className="text-fd-foreground underline underline-offset-4">
          AI page
        </Link>{' '}
        has an Agent Skill, an MCP server, and more prompts.
      </p>
      <div className="mt-3 flex items-start gap-2 rounded-lg border bg-fd-background py-2 pl-3 pr-2">
        <p className="flex-1 pt-1 font-mono text-[13px] leading-relaxed">{quickStartPrompt}</p>
        <CopyButton text={quickStartPrompt} label="Copy prompt" />
      </div>
    </aside>
  )
}
