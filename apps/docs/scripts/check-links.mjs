import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const output = path.resolve(fileURLToPath(new URL('../out/', import.meta.url)))
const origin = 'https://docs.invalid'

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const name = path.join(directory, entry.name)
      return entry.isDirectory() ? filesIn(name) : [name]
    }),
  )
  return nested.flat()
}

function decodeAttribute(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, entity) =>
      String.fromCodePoint(
        entity[0].toLowerCase() === 'x' ? parseInt(entity.slice(1), 16) : Number(entity),
      ),
    )
}

const files = await filesIn(output)
const exported = new Set(files)
const html = new Map(
  await Promise.all(
    files
      .filter((file) => file.endsWith('.html'))
      .map(async (file) => {
        const content = await readFile(file, 'utf8')
        return [
          file,
          {
            content,
            ids: new Set(
              [...content.matchAll(/\bid="([^"]+)"/g)].map((match) => decodeAttribute(match[1])),
            ),
          },
        ]
      }),
  ),
)
assert(exported.has(path.join(output, 'index.html')), 'The overview was not exported at /.')
const search = path.join(output, 'api/search')
assert(exported.has(search), 'The static search index was not exported.')
JSON.parse(await readFile(search, 'utf8'))

const errors = []
let checked = 0
for (const [file, page] of html) {
  const relative = path.relative(output, file).split(path.sep).join('/')
  const pathname = `/${relative.replace(/index\.html$/, '')}`
  for (const match of page.content.matchAll(/\b(href|src)="([^"]+)"/g)) {
    const target = new URL(decodeAttribute(match[2]), `${origin}${pathname}`)
    if (target.origin !== origin) continue
    const name = path.resolve(output, `.${decodeURIComponent(target.pathname)}`)
    if (!name.startsWith(`${output}${path.sep}`) && name !== output) {
      errors.push(`${pathname}: link leaves export directory: ${match[2]}`)
      continue
    }
    const resolved = [name, path.join(name, 'index.html'), `${name}.html`].find((candidate) =>
      exported.has(candidate),
    )
    if (!resolved) {
      errors.push(`${pathname}: missing ${target.pathname}`)
      continue
    }
    const fragment = decodeURIComponent(target.hash.slice(1))
    if (
      fragment &&
      !fragment.startsWith(':~:') &&
      html.has(resolved) &&
      !html.get(resolved).ids.has(fragment)
    ) {
      errors.push(`${pathname}: missing fragment ${target.pathname}#${fragment}`)
    }
    checked++
  }
}
assert.equal(errors.length, 0, `Broken exported links:\n${errors.join('\n')}`)
console.log(
  `Verified ${html.size} HTML files and ${checked} internal links and assets. Search index: ${(await stat(search)).size} bytes.`,
)
