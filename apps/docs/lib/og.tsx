import { ImageResponse } from 'next/og'
import { Mark } from '@/components/mark'
import { site } from '@/lib/site'

export const ogSize = { width: 1200, height: 630 }

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
        backgroundColor: '#0e0e0e',
        color: '#f2f2f2',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <Mark tile="#f4a261" ink="#1c1206" width={56} height={56} />
        <span style={{ fontSize: 36, fontWeight: 600 }}>{site.name}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 'auto' }}>
        <span style={{ fontSize: 72, fontWeight: 700, lineHeight: 1.1, letterSpacing: -1.5 }}>
          {title}
        </span>
        {description && (
          <span style={{ fontSize: 34, lineHeight: 1.35, color: '#a3a3a3', marginTop: 24 }}>
            {description}
          </span>
        )}
      </div>
      <span style={{ fontSize: 28, color: '#f4a261', marginTop: 48 }}>
        {new URL(site.url).host}
      </span>
    </div>,
    ogSize,
  )
}
