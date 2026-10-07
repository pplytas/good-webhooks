import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import mdxLoader from 'fumadocs-mdx/webpack/mdx'

// Exercise the same dependency hook used by Next's MDX loader, including type-only imports.
const cases = [
  ['delivery', 'types.d.ts'],
  ['verify', 'crypto.d.ts'],
  ['migrations', 'migrations.d.ts'],
]
await Promise.all(
  cases.map(async ([page, declaration]) => {
    const resourcePath = path.resolve(`content/docs/reference/${page}.mdx`)
    const source = await readFile(resourcePath, 'utf8')
    const dependencies = new Set()
    await new Promise((resolve, reject) => {
      mdxLoader.call(
        {
          resourcePath,
          resourceQuery: '?collection=docs',
          mode: 'production',
          getOptions: () => ({
            type: 'turbopack',
            isDev: false,
            configPath: path.resolve('source.config.ts'),
            compiledConfigPath: path.resolve('.source/source.config.mjs'),
            outDir: path.resolve('.source'),
          }),
          cacheable() {},
          addDependency(file) {
            dependencies.add(path.resolve(file))
          },
          async: () => (error, output) => (error ? reject(error) : resolve(output)),
        },
        source,
      )
    })
    for (const input of [
      'tsconfig.reference.json',
      'content/reference-types.ts',
      `../../packages/good-webhooks/dist/${declaration}`,
    ]) {
      assert(dependencies.has(path.resolve(input)), `${page}: untracked type-table input ${input}`)
    }
  }),
)
console.log('Verified MDX invalidation dependencies for all three generated type tables.')
