import assert from 'node:assert/strict'
import pkg from '../../../packages/good-webhooks/package.json' with { type: 'json' }
import { startServer } from './server.mjs'

const siteUrl = new URL(pkg.homepage).origin
const { url, stop } = await startServer()
const errors = []
const pages = new Map()

function decodeAttribute(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, entity) =>
      String.fromCodePoint(
        entity[0].toLowerCase() === 'x' ? parseInt(entity.slice(1), 16) : Number(entity),
      ),
    )
}

/** Fetch a same-origin path once; HTML responses keep their element IDs for fragment checks. */
function load(path) {
  if (!pages.has(path)) {
    pages.set(
      path,
      fetch(`${url}${path}`, { redirect: 'manual' }).then(async (response) => {
        const type = response.headers.get('content-type') ?? ''
        const body = await response.text()
        const ids = type.startsWith('text/html')
          ? new Set([...body.matchAll(/\bid="([^"]+)"/g)].map((match) => decodeAttribute(match[1])))
          : null
        return { status: response.status, type, body, ids }
      }),
    )
  }
  return pages.get(path)
}

async function checkLink(from, href, base) {
  const target = new URL(href, base)
  if (target.origin === siteUrl) target.host = new URL(url).host
  if (target.origin !== url) return 0
  const loaded = await load(target.pathname)
  if (loaded.status !== 200) {
    errors.push(`${from}: ${target.pathname} returned ${loaded.status}`)
    return 1
  }
  const fragment = decodeURIComponent(target.hash.slice(1))
  if (fragment && !fragment.startsWith(':~:') && loaded.ids && !loaded.ids.has(fragment)) {
    errors.push(`${from}: missing fragment ${target.pathname}#${fragment}`)
  }
  return 1
}

let checked = 0
try {
  const sitemap = await load('/sitemap.xml')
  assert.equal(sitemap.status, 200, 'sitemap.xml is missing.')
  const documents = [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
    (match) => new URL(match[1]).pathname,
  )
  assert(documents.includes('/') && documents.includes('/docs'), 'The sitemap lacks / or /docs.')

  // Every HTML page: its links, assets, and fragments resolve.
  for (const path of documents) {
    const page = await load(path)
    if (page.status !== 200) {
      errors.push(`sitemap: ${path} returned ${page.status}`)
      continue
    }
    const hrefs = [...page.body.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) =>
      decodeAttribute(m[1]),
    )
    const results = await Promise.all(hrefs.map((href) => checkLink(path, href, `${url}${path}`)))
    checked += results.reduce((sum, value) => sum + value, 0)
  }

  // Every Markdown export listed in llms.txt, and the links inside it.
  const index = await load('/llms.txt')
  assert.equal(index.status, 200, 'llms.txt is missing.')
  const exports = [...index.body.matchAll(/\]\((https?:\/\/[^)\s]+\.md)\)/g)]
    .map((m) => m[1])
    .filter((link) => link.startsWith(`${siteUrl}/`))
  assert.equal(exports.length, documents.length - 1, 'llms.txt must list every docs page.')
  for (const link of exports) {
    const { pathname } = new URL(link)
    const markdown = await load(pathname)
    if (markdown.status !== 200 || !markdown.type.startsWith('text/markdown')) {
      errors.push(`llms.txt: ${pathname} returned ${markdown.status} ${markdown.type}`)
      continue
    }
    const links = [...markdown.body.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1])
    const results = await Promise.all(links.map((href) => checkLink(pathname, href, href)))
    checked += results.reduce((sum, value) => sum + value, 0)
  }

  // Content negotiation: the same URL serves Markdown to agents that ask for it.
  for (const path of ['/docs', '/docs/quick-start']) {
    const response = await fetch(`${url}${path}`, { headers: { accept: 'text/markdown' } })
    const text = await response.text()
    if (
      !response.headers.get('content-type')?.startsWith('text/markdown') ||
      !text.startsWith('# ')
    ) {
      errors.push(`Accept: text/markdown on ${path} did not return Markdown.`)
    }
  }

  const full = await load('/llms-full.txt')
  assert.equal(full.status, 200, 'llms-full.txt is missing.')
  const search = await fetch(`${url}/api/search?query=replay`).then((response) => response.json())
  assert(Array.isArray(search) && search.length > 0, 'Search returned no results for "replay".')
} finally {
  await stop()
}

assert.equal(errors.length, 0, `Broken links:\n${errors.join('\n')}`)
console.log(
  `Verified ${pages.size} responses and ${checked} internal links, Markdown exports, content negotiation, and search.`,
)
