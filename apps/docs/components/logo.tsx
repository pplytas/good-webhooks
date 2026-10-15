import type { ComponentProps } from 'react'
import { Mark } from '@/components/mark'

/** The bare glyph in the current text color, like Better Auth's monochrome header mark. */
export function Logo(props: Omit<ComponentProps<'svg'>, 'viewBox' | 'fill'>) {
  return <Mark {...props} />
}
