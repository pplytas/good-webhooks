import type { ReactNode } from 'react'

/**
 * A left-to-right sequence of stages, stacked on narrow screens. It renders as an ordered
 * list, so screen readers and the Markdown export (see `lib/markdown-export.ts`) get the
 * same numbered steps the picture shows.
 */
export function Flow({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <figure className="not-prose my-6">
      <ol
        aria-label={title}
        className="grid gap-px overflow-hidden rounded-xl border bg-fd-border [counter-reset:flow] md:auto-cols-fr md:grid-flow-col"
      >
        {children}
      </ol>
      {title ? (
        <figcaption className="mt-2 text-center text-xs text-fd-muted-foreground">
          {title}
        </figcaption>
      ) : null}
    </figure>
  )
}

export function FlowStep({
  title,
  actor,
  children,
}: {
  title: string
  actor?: string
  children?: ReactNode
}) {
  return (
    <li className="group relative flex flex-col gap-1.5 bg-fd-card p-4 [counter-increment:flow]">
      <span className="flex items-center gap-2 font-mono text-xs text-fd-muted-foreground before:content-[counter(flow,decimal-leading-zero)]">
        {actor ? <span className="rounded border px-1.5 py-px">{actor}</span> : null}
      </span>
      <span className="text-sm font-medium text-fd-foreground">{title}</span>
      {children ? (
        <span className="text-sm leading-relaxed text-fd-muted-foreground [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:text-fd-foreground">
          {children}
        </span>
      ) : null}
      <span
        aria-hidden="true"
        className="absolute z-10 hidden size-5 items-center justify-center rounded-full border bg-fd-background text-[10px] text-fd-muted-foreground group-last:hidden md:-right-2.5 md:top-1/2 md:flex md:-translate-y-1/2"
      >
        →
      </span>
    </li>
  )
}
