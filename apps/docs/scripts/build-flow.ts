/**
 * Draws the README pipeline, `public/readme/pipeline-{light,dark}.png`, in the layout of the docs
 * `Flow` component: one row of actors joined by a line with arrowheads, and under each actor the
 * call it makes and what it does, in cells divided by hairlines. The words follow the image alt
 * text in both READMEs, so change them together. Run with `pnpm build:flow`; text uses Geist and
 * Geist Mono when installed, else Helvetica and Menlo. Existing files are kept (see
 * `readme-asset.ts`), so a new picture needs new file names.
 */
import sharp from 'sharp'
import { writeReadmeAsset } from './readme-asset.ts'

const stages = [
  { actor: 'your app', call: 'publish()', lines: ['records the event', 'in your transaction'] },
  { actor: 'PostgreSQL', call: 'webhook tables', lines: ['one delivery', 'per endpoint'] },
  { actor: 'worker', call: 'worker.run()', lines: ['signs, sends,', 'retries, records'] },
  { actor: 'receiver', call: 'parseWebhook()', lines: ['verifies it, returns', 'a typed event'] },
]

// Each theme matches the site palette; the lines are a step stronger than the site borders
// because the image is shown scaled down on GitHub and npm.
const themes = {
  light: { card: '#fafafa', box: '#ffffff', line: '#e2e2e2', ink: '#0a0a0a', mute: '#5c5c5c' },
  dark: { card: '#141414', box: '#0f0f0f', line: '#2c2c2c', ink: '#ededed', mute: '#a3a3a3' },
} as const

const width = 1020
const height = 232
const column = width / stages.length
const track = 76
const sans = "Geist, 'Helvetica Neue', Helvetica, Arial, sans-serif"
const mono = "'Geist Mono', Menlo, monospace"
/** Geist Mono advances 0.6em per character; Menlo is within a pixel at these sizes. */
const monoWidth = (text: string, size: number) => text.length * size * 0.6

function svg(theme: (typeof themes)[keyof typeof themes]) {
  const parts: string[] = []
  const boxes = stages.map((stage, index) => {
    const w = monoWidth(stage.actor, 15) + 28
    return { x: index * column + column / 2 - w / 2, w }
  })
  const mid = track / 2

  // Frame, the track's lower rule, and dividers below it.
  parts.push(
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="${theme.card}" stroke="${theme.line}"/>`,
    `<line x1="0" y1="${track + 0.5}" x2="${width}" y2="${track + 0.5}" stroke="${theme.line}"/>`,
  )
  for (let index = 1; index < stages.length; index++) {
    const x = Math.round(index * column) + 0.5
    parts.push(`<line x1="${x}" y1="${track}" x2="${x}" y2="${height}" stroke="${theme.line}"/>`)
  }

  // One line from the first actor to the last, with an arrowhead into each later actor.
  parts.push(
    `<line x1="${boxes[0]!.x + boxes[0]!.w}" y1="${mid + 0.5}" x2="${boxes.at(-1)!.x}" y2="${mid + 0.5}" stroke="${theme.line}"/>`,
  )
  boxes.forEach(({ x, w }, index) => {
    if (index > 0) {
      parts.push(
        `<path d="M${x - 8} ${mid - 4.5}L${x} ${mid + 0.5}L${x - 8} ${mid + 5.5}Z" fill="${theme.mute}"/>`,
      )
    }
    parts.push(
      `<rect x="${x + 0.5}" y="${mid - 15.5}" width="${w}" height="32" fill="${theme.box}" stroke="${theme.line}"/>`,
      `<text x="${x + w / 2}" y="${mid + 5.5}" text-anchor="middle" font-family="${mono}" font-size="15" fill="${theme.ink}">${stages[index]!.actor}</text>`,
    )
  })

  // The call and its effect, left-aligned in each cell.
  stages.forEach((stage, index) => {
    const x = index * column + 28
    parts.push(
      `<text x="${x}" y="${track + 48}" font-family="${mono}" font-size="17" fill="${theme.ink}">${stage.call}</text>`,
      ...stage.lines.map(
        (text, line) =>
          `<text x="${x}" y="${track + 92 + line * 26}" font-family="${sans}" font-size="17" fill="${theme.mute}">${text}</text>`,
      ),
    )
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`
}

for (const [name, theme] of Object.entries(themes)) {
  const png = await sharp(Buffer.from(svg(theme)), { density: 144 })
    .png()
    .toBuffer()
  await writeReadmeAsset(`pipeline-${name}.png`, png)
}
