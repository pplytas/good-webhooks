/**
 * Regenerates the static assets derived from `lib/mark.ts`:
 * `app/icon.svg`, `app/favicon.ico`, and the PNGs in `public/readme/`.
 * Run with `pnpm build:mark` after changing the mark geometry.
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { brand, markSvg } from '../lib/mark.ts'

const root = new URL('../', import.meta.url)
const svg = markSvg(brand)

/** Rasterizes the 32-unit grid to `size` pixels. */
function render(source: string, size: number) {
  return sharp(Buffer.from(source), { density: (72 * size) / 32 }).resize(size, size)
}

/** Wraps PNG images in an ICO container, one directory entry per image. */
function ico(images: { size: number; png: Buffer }[]) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const entries = Buffer.alloc(16 * images.length)
  let offset = header.length + entries.length
  images.forEach(({ size, png }, i) => {
    const entry = entries.subarray(i * 16)
    entry.writeUInt8(size === 256 ? 0 : size, 0)
    entry.writeUInt8(size === 256 ? 0 : size, 1)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += png.length
  })
  return Buffer.concat([header, entries, ...images.map(({ png }) => png)])
}

await writeFile(new URL('app/icon.svg', root), `${svg}\n`)

// The 16px entry is flat: the shine and shadow only muddy the hook at that size.
const icoImages = await Promise.all(
  [
    { size: 16, source: markSvg(brand, { flat: true }) },
    { size: 32, source: svg },
    { size: 48, source: svg },
  ].map(async ({ size, source }) => ({ size, png: await render(source, size).png().toBuffer() })),
)
await writeFile(new URL('app/favicon.ico', root), ico(icoImages))

// The README shows the mark at 56px; this is the tile alone at 3x, without the grid margin.
const tilePx = 168
const gridPx = (tilePx * 32) / 28
const margin = (gridPx - tilePx) / 2
await render(svg, gridPx)
  .extract({ left: margin, top: margin, width: tilePx, height: tilePx })
  .png()
  .toFile(fileURLToPath(new URL('public/readme/mark.png', root)))

// Published npm READMEs retain these URLs, but npm strips the picture theme selector.
// A background keeps the fallback wordmark readable in light, dark, and system modes.
for (const [theme, ink, background] of [
  ['light', '#09090b', '#fafafa'],
  ['dark', '#fafafa', '#18181b'],
] as const) {
  const wordmark = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="168" viewBox="0 0 960 168">
    <rect width="960" height="168" rx="24" fill="${background}"/>
    ${svg.replace('<svg ', '<svg x="3" y="12" width="144" height="144" ')}
    <text x="168" y="118" font-family="Arial, Helvetica, sans-serif" font-size="94" font-weight="700" fill="${ink}">Good Webhooks</text>
  </svg>`
  await sharp(Buffer.from(wordmark))
    .png()
    .toFile(fileURLToPath(new URL(`public/readme/wordmark-${theme}.png`, root)))
}

console.log(
  'Wrote app/icon.svg, app/favicon.ico, public/readme/{mark,wordmark-light,wordmark-dark}.png',
)
