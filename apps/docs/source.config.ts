import { defineConfig, defineDocs } from 'fumadocs-mdx/config'
import {
  createGenerator,
  createProject,
  remarkAutoTypeTable,
  type Generator,
} from 'fumadocs-typescript'

export const docs = defineDocs({ dir: 'content/docs' })

const generator: Generator = {
  ...createGenerator({ tsconfigPath: 'tsconfig.reference.json' }),
  async generateTypeTable(...args) {
    const project = await createProject({ tsconfigPath: 'tsconfig.reference.json' })
    try {
      return await createGenerator({ project }).generateTypeTable(...args)
    } finally {
      // The native TypeScript process must exit for Turbopack's MDX worker to finish.
      project.close()
    }
  },
}

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [[remarkAutoTypeTable, { generator }]],
  },
})
