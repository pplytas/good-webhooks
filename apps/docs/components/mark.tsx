import type { ComponentProps } from 'react'
import { mark, type MarkColors } from '@/lib/mark'

type MarkProps = MarkColors & {
  /** Prefix for the gradient ids, in case two differently colored marks share a page. */
  id?: string
} & Omit<ComponentProps<'svg'>, 'viewBox' | 'fill' | 'id'>

/**
 * The mark from `lib/mark.ts` as React elements. Colors are plain attributes so the
 * same component renders in the DOM and in `next/og` images.
 */
export function Mark({ tile, ink, id = 'mark', ...props }: MarkProps) {
  const { tile: t, hook, shine } = mark
  const rect = { x: t.x, y: t.y, width: t.size, height: t.size, rx: t.radius }
  return (
    <svg viewBox={mark.viewBox} fill="none" aria-hidden="true" {...props}>
      <defs>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="0" y2="1">
          {shine.tile.map((stop) => (
            <stop
              key={stop.offset}
              offset={stop.offset}
              stopColor={stop.color}
              stopOpacity={stop.opacity}
            />
          ))}
        </linearGradient>
        <linearGradient id={`${id}-hook`} x1="0" y1="0" x2="1" y2="1">
          {shine.hook.map((stop) => (
            <stop
              key={stop.offset}
              offset={stop.offset}
              stopColor={stop.color}
              stopOpacity={stop.opacity}
            />
          ))}
        </linearGradient>
        <filter id={`${id}-shadow`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation={hook.shadow.blur} />
        </filter>
      </defs>
      <rect {...rect} fill={tile} />
      <rect {...rect} fill={`url(#${id}-tile)`} />
      <g transform={`rotate(${hook.tilt} 16 16)`}>
        <path
          d={hook.d}
          transform={`translate(${hook.shadow.dx} ${hook.shadow.dy})`}
          fill="#000"
          opacity={hook.shadow.opacity}
          filter={`url(#${id}-shadow)`}
        />
        <path d={hook.d} fill={ink} />
        <path d={hook.d} fill={`url(#${id}-hook)`} />
      </g>
    </svg>
  )
}
