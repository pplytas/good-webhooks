import { ImageResponse } from 'next/og'
import { Mark } from '@/components/mark'
import { brand } from '@/lib/mark'

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
        backgroundColor: brand.tile,
      }}
    >
      <Mark tile={brand.tile} ink={brand.ink} width={168} height={168} />
    </div>,
    size,
  )
}
