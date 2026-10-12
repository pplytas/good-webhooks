import { ImageResponse } from 'next/og'
import { Mark } from '@/lib/og'

export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

/** iOS rounds the corners itself, so the mark sits on a full-bleed background. */
export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        backgroundColor: '#09090b',
      }}
    >
      <Mark size={140} color="#fafafa" background="#09090b" />
    </div>,
    size,
  )
}
