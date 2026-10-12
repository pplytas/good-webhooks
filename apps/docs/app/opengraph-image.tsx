import { ogImage, ogSize } from '@/lib/og'
import { site } from '@/lib/site'

export const alt = site.name
export const size = ogSize
export const contentType = 'image/png'

export default function Image() {
  return ogImage({
    title: site.description,
    description:
      'Typed events, Standard Webhooks signing, and transactional publish on PostgreSQL.',
  })
}
