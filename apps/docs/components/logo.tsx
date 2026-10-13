import type { ComponentProps } from 'react'
import { Mark } from '@/components/mark'

/** The mark in the theme's accent, like the primary button. */
export function Logo(props: Omit<ComponentProps<'svg'>, 'viewBox' | 'fill'>) {
  return <Mark tile="var(--color-fd-primary)" ink="var(--color-fd-primary-foreground)" {...props} />
}
