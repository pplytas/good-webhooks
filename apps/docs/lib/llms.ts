import { llms } from 'fumadocs-core/source/llms'
import { source } from '@/lib/source'
import { site } from '@/lib/site'

export const docsLlms = llms(source, {
  async renderPage(page) {
    const body = await page.data.getText('processed')
    return `# ${page.data.title}\n\n${page.data.description}\n\nSource: ${site.url}${page.url}\n\n${body}`
  },
})

/** `/docs/a/b` is exported as `/llms.mdx/a/b.md`; the introduction is `/llms.mdx/index.md`. */
export function markdownUrl(slug: string[] | undefined): string {
  const segments = slug?.length ? [...slug] : ['index']
  segments[segments.length - 1] += '.md'
  return `/llms.mdx/${segments.join('/')}`
}
