import { notFound } from 'next/navigation'
import { docsLlms } from '@/lib/llms'
import { source } from '@/lib/source'

export const dynamic = 'force-static'
export const dynamicParams = false

export function generateStaticParams() {
  return source.generateParams().map(({ slug }) => {
    const segments = slug?.length ? [...slug] : ['index']
    segments[segments.length - 1] += '.md'
    return { slug: segments }
  })
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params
  if (!slug?.length) notFound()
  const segments = [...slug]
  segments[segments.length - 1] = segments[segments.length - 1]!.replace(/\.md$/, '')
  const page = source.getPage(segments.length === 1 && segments[0] === 'index' ? [] : segments)
  if (!page) notFound()
  return new Response(await docsLlms.page(page), {
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  })
}
