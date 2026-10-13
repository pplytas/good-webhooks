/**
 * The Good Webhooks mark: a g-shaped hook on a rounded tile, drawn on a 32-unit grid. A vertical
 * gradient on the tile, a diagonal gradient on the glyph, and a soft drop shadow give it a slight
 * 2.5D lift. Every rendering (navbar, favicon, social cards, README) derives from this geometry,
 * so change the shape here and run `pnpm build:mark`.
 */
export const mark = {
  viewBox: '0 0 32 32',
  tile: { x: 2, y: 2, size: 28, radius: 7 },
  /**
   * A lowercase g whose descender is a fishhook, as one nonzero-filled path: the bowl is a ring
   * (outer circle clockwise, inner counterclockwise), the ear is a capsule leaving the bowl at
   * -40deg, and the stem drops into an S-curve that becomes the lower loop, whose arm tapers (its
   * inner edge is an off-center circle) and ends in a barbed point curling back toward the bowl.
   */
  hook: {
    d: 'M10.2 10.9A5.2 5.2 0 1 1 20.6 10.9A5.2 5.2 0 1 1 10.2 10.9ZM12.6 10.9A2.8 2.8 0 1 0 18.2 10.9A2.8 2.8 0 1 0 12.6 10.9ZM17.69 7.41L20.22 5.29A1.2 1.2 0 0 1 21.76 7.13L19.24 9.25ZM16.1 14.9L16.1 15.4C16.1 16.91 18.71 17.35 19.56 18.36A5.5 5.5 0 1 1 9.9 21.13C10.14 19.45 11.85 19.55 12.4 18.6L12.45 22.5L11.78 21.72A3.3 3.3 0 1 0 17.61 19.65C16.48 18.32 13.7 18.39 13.7 15.4L13.7 14.9Z',
    /** Letters stay upright; kept so the renderers can lean a future mark. */
    tilt: 0,
    shadow: { dx: 0, dy: 0.8, blur: 0.5, opacity: 0.26 },
  },
  /** Light and shade overlays, expressed as white and black stops so any base colors work. */
  shine: {
    tile: [
      { offset: 0, color: '#fff', opacity: 0.2 },
      { offset: 0.55, color: '#fff', opacity: 0 },
      { offset: 1, color: '#000', opacity: 0.14 },
    ],
    hook: [
      { offset: 0, color: '#fff', opacity: 0.34 },
      { offset: 0.5, color: '#fff', opacity: 0 },
      { offset: 1, color: '#000', opacity: 0.24 },
    ],
  },
} as const

export type MarkColors = { tile: string; ink: string }

/** The accent colors for static assets: the dark theme's primary and its foreground. */
export const brand: MarkColors = { tile: '#f4a261', ink: '#1c1206' }

const stops = (list: readonly { offset: number; color: string; opacity: number }[]) =>
  list
    .map(
      ({ offset, color, opacity }) =>
        `<stop offset="${offset}" stop-color="${color}" stop-opacity="${opacity}"/>`,
    )
    .join('')

/**
 * The mark as a standalone SVG document, for assets generated outside React.
 * `flat: true` drops the shine and shadow, which only muddy the mark below about 24px.
 */
export function markSvg({ tile, ink }: MarkColors, { flat = false, id = 'mark' } = {}): string {
  const { tile: t, hook, shine } = mark
  const rect = `x="${t.x}" y="${t.y}" width="${t.size}" height="${t.size}" rx="${t.radius}"`
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mark.viewBox}">`,
    flat
      ? ''
      : `<defs>` +
        `<linearGradient id="${id}-tile" x1="0" y1="0" x2="0" y2="1">${stops(shine.tile)}</linearGradient>` +
        `<linearGradient id="${id}-hook" x1="0" y1="0" x2="1" y2="1">${stops(shine.hook)}</linearGradient>` +
        `<filter id="${id}-shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${hook.shadow.blur}"/></filter>` +
        `</defs>`,
    `<rect ${rect} fill="${tile}"/>`,
    flat ? '' : `<rect ${rect} fill="url(#${id}-tile)"/>`,
    `<g transform="rotate(${hook.tilt} 16 16)">`,
    flat
      ? ''
      : `<path d="${hook.d}" transform="translate(${hook.shadow.dx} ${hook.shadow.dy})" fill="#000" opacity="${hook.shadow.opacity}" filter="url(#${id}-shadow)"/>`,
    `<path d="${hook.d}" fill="${ink}"/>`,
    flat ? '' : `<path d="${hook.d}" fill="url(#${id}-hook)"/>`,
    '</g>',
    '</svg>',
  ]
    .filter(Boolean)
    .join('\n')
}
