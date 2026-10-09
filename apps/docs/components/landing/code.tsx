import { highlight } from 'fumadocs-core/highlight'
import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock'

export async function Code({
  code,
  lang,
  title,
}: {
  code: string
  lang: 'ts' | 'bash' | 'http'
  title?: string
}) {
  const rendered = await highlight(code, {
    lang,
    // Keep in sync with rehypeCodeOptions in source.config.ts.
    themes: { light: 'github-light-high-contrast', dark: 'github-dark-high-contrast' },
    defaultColor: false,
    components: {
      // Shiki inlines the theme background; the code block supplies its own surface instead.
      pre: ({ style: _style, ...props }) => <Pre {...props} />,
    },
  })
  return (
    <CodeBlock title={title} className="my-0 text-[13px]">
      {rendered}
    </CodeBlock>
  )
}
