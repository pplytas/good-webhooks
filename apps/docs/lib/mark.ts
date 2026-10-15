/**
 * The Good Webhooks mark: a pixel G whose inner block turns back like the barb of a hook, on a
 * 32-unit grid with square corners. It renders either alone in the current text color (navbar,
 * social cards) or drawn on a square tile (favicon, app icon).
 * Every rendering derives from this geometry, so change the shape here and run `pnpm build:mark`.
 */
export const mark = {
  viewBox: '0 0 32 32',
  /** The glyph alone fills a 24-unit square; on a tile it shrinks to leave a margin. */
  glyph: { x: 4, y: 4, size: 24 },
  tile: { size: 32, glyph: { x: 8, y: 8, size: 16 } },
} as const

/**
 * The G as one outline inside a square at (x, y) of side `size`, so renderers never leave seams
 * between parts. It is a 4 by 4 pixel G: a full top row, a left column, a full bottom row, and a
 * right half block whose inner edge turns back toward the stem like a barb. The hollow is the
 * second row and one cell below it.
 */
export function glyphPath(x: number, y: number, size: number): string {
  const cell = size / 4
  const half = size / 2
  const points = [
    [0, 0],
    [size, 0],
    [size, cell],
    [cell, cell],
    [cell, size - cell],
    [half, size - cell],
    [half, half],
    [size, half],
    [size, size],
    [0, size],
  ]
  return `M${points.map(([px, py]) => `${x + px} ${y + py}`).join('L')}Z`
}

export type MarkColors = { tile: string; ink: string }

/** The accent colors for static assets: the dark theme's primary on near-black ink. */
export const brand: MarkColors = { tile: '#f4a261', ink: '#0a0a0a' }

/** The mark on its tile as a standalone SVG document, for assets generated outside React. */
export function markSvg({ tile, ink }: MarkColors): string {
  const { size, glyph } = mark.tile
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mark.viewBox}">`,
    `<rect width="${size}" height="${size}" fill="${tile}"/>`,
    `<path d="${glyphPath(glyph.x, glyph.y, glyph.size)}" fill="${ink}"/>`,
    '</svg>',
  ].join('\n')
}
