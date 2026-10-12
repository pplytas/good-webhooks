import { ImageResponse } from 'next/og'
import { site } from '@/lib/site'

export const ogSize = { width: 1200, height: 630 }

/** The envelope mark from `components/logo.tsx`, with fixed colors for image rendering. */
export function Mark({ size, color = '#fafafa', background = '#09090b' }: MarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <rect x="2" y="2" width="28" height="28" rx="6" fill={color} />
      <path
        d="M9 12.5 16 17l7-4.5M9 11h14v10H9z"
        stroke={background}
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

type MarkProps = { size: number; color?: string; background?: string }

/**
 * A monochrome social card. No version number: platforms cache these images for weeks.
 */
export function ogImage({ title, description }: { title: string; description?: string }) {
  return new ImageResponse(
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        padding: '72px 80px',
        backgroundColor: '#09090b',
        color: '#fafafa',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <Mark size={56} />
        <span style={{ fontSize: 36, fontWeight: 600 }}>{site.name}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 'auto' }}>
        <span style={{ fontSize: 72, fontWeight: 700, lineHeight: 1.1, letterSpacing: -1.5 }}>
          {title}
        </span>
        {description && (
          <span style={{ fontSize: 34, lineHeight: 1.35, color: '#a1a1aa', marginTop: 24 }}>
            {description}
          </span>
        )}
      </div>
      <span style={{ fontSize: 28, color: '#6b6b74', marginTop: 48 }}>
        {new URL(site.url).host}
      </span>
    </div>,
    ogSize,
  )
}
