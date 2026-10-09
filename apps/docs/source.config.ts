import path from 'node:path'
import { defineConfig, defineDocs } from 'fumadocs-mdx/config'
import { createGenerator, createProject, remarkAutoTypeTable } from 'fumadocs-typescript'
import { stringifyComponent } from './lib/markdown-export'

// Keep in sync with components/landing/code.tsx. Verified for 4.5:1 on every code surface.
const codeThemes = {
  light: 'github-light-high-contrast',
  dark: 'github-dark-high-contrast',
} as const

export const docs = defineDocs({
  dir: 'content/docs',
  docs: { postprocess: { includeProcessedMarkdown: { stringify: stringifyComponent } } },
})

function remarkTypeTables(): ReturnType<typeof remarkAutoTypeTable> {
  return async (tree, file) => {
    // Fumadocs exposes the bundler's dependency tracking through the MDX file.
    const compiler = file.data._compiler as { addDependency(file: string): void } | undefined
    const generator = createGenerator()
    generator.generateDocumentation = async (input, name, options) => {
      const tsconfigPath = path.resolve('tsconfig.reference.json')
      compiler?.addDependency(tsconfigPath)
      const project = await createProject({ tsconfigPath })
      try {
        const result = await createGenerator({ project }).generateDocumentation(
          input,
          name,
          options,
        )
        const loaded = project.getSourceFile(path.resolve(input.path))
        for (const dependency of loaded?.project.program.getSourceFileNames() ?? []) {
          compiler?.addDependency(dependency)
        }
        return result
      } finally {
        // The native TypeScript process must exit for Turbopack's MDX worker to finish.
        project.close()
      }
    }
    const result = await remarkAutoTypeTable({ generator, shiki: { themes: codeThemes } })(
      tree,
      file,
      (error) => {
        if (error) throw error
      },
    )
    if (result instanceof Error) throw result
    return result
  }
}

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: { themes: codeThemes },
    remarkPlugins: [remarkTypeTables],
  },
})
