import type * as PageTree from 'fumadocs-core/page-tree'
import { llms } from 'fumadocs-core/source/llms'
import { source } from '@/lib/source'
import { site } from '@/lib/site'

/** The Markdown URL of a page: `/docs/a/b` is `/docs/a/b.md`; the introduction is `/docs.md`. */
export function markdownUrl(slug: string[] | undefined): string {
  return slug?.length ? `/docs/${slug.join('/')}.md` : '/docs.md'
}

/**
 * Point site-relative links at absolute URLs, and docs links at their Markdown export, so an
 * agent reading one exported page can follow links without rendering HTML.
 */
function absoluteLinks(markdown: string): string {
  return markdown.replace(/\]\((\/[^)\s]*)\)/g, (_, target: string) => {
    const [path = '', hash] = target.split('#')
    const docs = /^\/docs(?:\/(.*?))?\/?$/.exec(path)
    const url = docs ? markdownUrl(docs[1]?.split('/').filter(Boolean)) : path
    return `](${site.url}${url}${hash ? `#${hash}` : ''})`
  })
}

export const docsLlms = llms(source, {
  async renderPage(page) {
    const body = await page.data.getText('processed')
    return absoluteLinks(
      `# ${page.data.title}\n\n> ${page.data.description}\n\nSource: ${site.url}${page.url}\n\n${body}`,
    )
  },
})

const summary = [
  `# ${site.name}`,
  '',
  `> ${site.name} is a TypeScript library for sending webhooks from a Node.js application. You publish typed events; it stores them in your PostgreSQL database, delivers signed Standard Webhooks requests from a worker you run, retries failures, keeps attempt history, and supports replay. Receivers verify requests with one function. Endpoints are managed through a standalone PostgreSQL provider or a Better Auth plugin.`,
  '',
  `Version ${site.version}. Requires Node.js 24 or later and PostgreSQL 16 or 17. Better Auth ${site.betterAuthRange} is optional.`,
  '',
  '**When to use it:** your application sends webhooks to endpoints your users register and you want delivery to live in your own process and database, with no hosted service.',
  '',
  '**When not to use it:** edge runtimes, delivery storage other than PostgreSQL, or a fully hosted webhook service.',
  '',
  '**How to use these docs:** every link below is a Markdown page. For a runnable start, read the quick start. For an existing app, read installation, publish events, run workers, and receive webhooks, then the production checklist. All pages in one file: ' +
    `${site.url}/llms-full.txt`,
]

/** An llms.txt index (https://llmstxt.org): one H2 section per sidebar folder. */
export function llmsIndex(): string {
  const lines = [...summary]
  const optional: string[] = []
  for (const node of source.getPageTree().children) {
    // Every root entry is a sidebar folder; anything else would silently miss the index.
    if (node.type !== 'folder') throw new Error(`Root sidebar entry is not a folder: ${node.type}`)
    const pages = pagesIn(node).map(entry)
    if (node.name === 'Resources') optional.push(...pages)
    else lines.push('', `## ${String(node.name)}`, '', ...pages)
  }
  return [...lines, '', '## Optional', '', ...optional, ''].join('\n')
}

/** Pages in a folder and its sub-folders, in sidebar order. */
function pagesIn(folder: PageTree.Folder): PageTree.Item[] {
  return folder.children.flatMap((child) =>
    child.type === 'page' ? [child] : child.type === 'folder' ? pagesIn(child) : [],
  )
}

function entry(node: PageTree.Item): string {
  if (node.external || /^https?:\/\//.test(node.url)) return `- [${String(node.name)}](${node.url})`
  const page = source.getNodePage(node)
  if (!page) throw new Error(`No page for ${node.url}`)
  return `- [${page.data.title}](${site.url}${markdownUrl(page.slugs)}): ${page.data.description}`
}
