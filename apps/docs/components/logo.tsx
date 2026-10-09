import type { ComponentProps } from 'react'

/** A monochrome envelope mark. Inherits the current text color. */
export function Logo(props: ComponentProps<'svg'>) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" {...props}>
      <rect x="2" y="2" width="28" height="28" rx="6" fill="currentColor" />
      <path
        d="M9 12.5 16 17l7-4.5M9 11h14v10H9z"
        className="stroke-fd-background"
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}
