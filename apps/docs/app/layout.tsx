import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { RootProvider } from 'fumadocs-ui/provider/next'
import SearchDialog from '@/components/search'
import './global.css'

export const metadata: Metadata = {
  title: {
    default: 'Good Webhooks',
    template: '%s | Good Webhooks',
  },
  description: 'Build webhook delivery into your TypeScript application.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ SearchDialog }}>{children}</RootProvider>
      </body>
    </html>
  )
}
