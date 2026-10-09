import type { LLMsOptions } from 'fumadocs-core/mdx-plugins/remark-llms'

type Stringify = NonNullable<LLMsOptions['stringify']>
type State = Parameters<Stringify>[2]
type Info = Parameters<Stringify>[3]
type Attribute = {
  type: string
  name?: string
  value?: string | { value: string } | null
}
type Element = {
  type: 'mdxJsxFlowElement' | 'mdxJsxTextElement'
  name: string | null
  attributes: Attribute[]
  children: { type: string }[]
}

/**
 * Markdown forms for the MDX components the docs use, so the `.md` exports, `llms-full.txt`,
 * and "Copy Markdown" carry plain Markdown instead of JSX: tab labels, card links, callout
 * titles, diagram text, and type tables survive as text an agent can read.
 */
export const stringifyComponent: Stringify = (input, _parent, state, info) => {
  if (input.type !== 'mdxJsxFlowElement' && input.type !== 'mdxJsxTextElement') return
  const node = input as unknown as Element
  switch (node.name) {
    case 'Tabs':
      return tabs(node, state, info)
    case 'Cards':
      return cards(node)
    case 'Callout':
      return callout(node, state, info)
    case 'Flow':
      return flow(node, state, info)
    case 'TypeTable':
      return typeTable(node)
    case 'Steps':
    case 'Step':
    case 'Accordions':
      return flowContent(node, state, info)
    case 'Accordion':
      return `**${attribute(node, 'title') ?? ''}**\n\n${flowContent(node, state, info)}`
  }
}

function flowContent(node: Element, state: State, info: Info): string {
  return state.containerFlow(node as never, info)
}

function attribute(node: Element, name: string): string | undefined {
  const found = node.attributes.find(
    (attr) => attr.type === 'mdxJsxAttribute' && attr.name === name,
  )
  if (!found || found.value == null) return
  return typeof found.value === 'string' ? found.value : found.value.value
}

function childElements(node: Element, name: string): Element[] {
  return node.children.filter(
    (child): child is Element =>
      (child.type === 'mdxJsxFlowElement' || child.type === 'mdxJsxTextElement') &&
      (child as Element).name === name,
  ) as Element[]
}

/** `items={['A', 'B']}` is an expression; read the string literals without evaluating it. */
function stringList(source: string | undefined): string[] {
  return [...(source ?? '').matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map(
    (match) => match[1] ?? match[2] ?? '',
  )
}

function tabs(node: Element, state: State, info: Info): string {
  const labels = stringList(attribute(node, 'items'))
  return childElements(node, 'Tab')
    .map((tab, index) => {
      const label = attribute(tab, 'value') ?? labels[index] ?? `Option ${index + 1}`
      return `**${label}**\n\n${flowContent(tab, state, info)}`
    })
    .join('\n\n')
}

function cards(node: Element): string {
  return childElements(node, 'Card')
    .map((card) => {
      const title = attribute(card, 'title') ?? ''
      const href = attribute(card, 'href')
      const text = plainText(card).trim()
      const link = href ? `[${title}](${href})` : title
      return `- ${link}${text ? `: ${text}` : ''}`
    })
    .join('\n')
}

const calloutLabels: Record<string, string> = {
  warn: 'Warning',
  warning: 'Warning',
  error: 'Important',
  idea: 'Tip',
  success: 'Note',
  info: 'Note',
}

function callout(node: Element, state: State, info: Info): string {
  const label = calloutLabels[attribute(node, 'type') ?? 'info'] ?? 'Note'
  const title = attribute(node, 'title')
  const body = flowContent(node, state, info)
  const lead = `**${label}${title ? `: ${title}` : ''}.**`
  return `${lead} ${body}`
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n')
}

function flow(node: Element, state: State, info: Info): string {
  const title = attribute(node, 'title')
  const steps = childElements(node, 'FlowStep').map((step, index) => {
    const name = attribute(step, 'title') ?? ''
    const actor = attribute(step, 'actor')
    const body = state.containerPhrasing(
      { type: 'paragraph', children: step.children } as never,
      info,
    )
    return `${index + 1}. **${name}**${actor ? ` (${actor})` : ''}: ${body.trim()}`
  })
  return [title ? `${title}:\n\n` : '', steps.join('\n')].join('')
}

type TypeEntry = {
  name: string
  description?: string
  type?: string
  simplifiedType?: string
  required?: boolean
  tags?: { name: string; text: string }[]
}

function typeTable(node: Element): string | undefined {
  const raw = attribute(node, 'type')
  if (!raw) return
  let parsed: { name?: string; entries?: TypeEntry[] }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return
  }
  const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim()
  const rows = (parsed.entries ?? []).map((entry) => {
    const fallback = entry.tags?.find((tag) => tag.name === 'default')?.text ?? ''
    const name = `\`${entry.name}${entry.required ? '' : '?'}\``
    const type = `\`${cell((entry.type ?? entry.simplifiedType ?? '').replace(/ \| undefined$/, ''))}\``
    return `| ${name} | ${type} | ${fallback ? `\`${cell(fallback)}\`` : ''} | ${cell(entry.description ?? '')} |`
  })
  return ['| Field | Type | Default | Description |', '| --- | --- | --- | --- |', ...rows].join(
    '\n',
  )
}

function plainText(node: { children?: unknown[]; value?: unknown }): string {
  if (typeof node.value === 'string') return node.value
  return (node.children ?? []).map((child) => plainText(child as never)).join('')
}
