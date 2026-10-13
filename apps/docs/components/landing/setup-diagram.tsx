/**
 * A small fan-in, fan-out drawing for a card header, in the same language as the delivery
 * drawing in the hero: boxed nodes, curved links, and a solid accent node in the middle.
 */
const width = 400
const height = 140
const leafHeight = 26
const hubHeight = 34
const edge = 12

function textWidth(label: string) {
  return label.length * 6.6
}

function rows(count: number) {
  const gap = count > 2 ? 38 : 46
  const top = height / 2 - ((count - 1) * gap) / 2
  return Array.from({ length: count }, (_, index) => top + index * gap)
}

function curve(x1: number, y1: number, x2: number, y2: number) {
  const mid = (x1 + x2) / 2
  return `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`
}

function Node({ x, y, label, hub }: { x: number; y: number; label: string; hub?: boolean }) {
  const w = textWidth(label) + (hub ? 28 : 22)
  const h = hub ? hubHeight : leafHeight
  const box = { x, y: y - h / 2, width: w, height: h, rx: hub ? 8 : 6 }
  return (
    <g>
      <rect
        {...box}
        className={
          hub ? 'fill-fd-primary stroke-fd-primary' : 'fill-fd-background stroke-fd-border'
        }
      />
      <text
        x={x + w / 2}
        y={y}
        dy="0.35em"
        textAnchor="middle"
        className={
          hub
            ? 'fill-fd-primary-foreground font-sans text-[13px] font-semibold'
            : 'fill-fd-muted-foreground font-mono text-[11px]'
        }
      >
        {label}
      </text>
    </g>
  )
}

export function SetupDiagram({
  from,
  through,
  to,
}: {
  from: string[]
  through: string
  to: string[]
}) {
  const middle = height / 2
  const hubWidth = textWidth(through) + 28
  const hubLeft = (width - hubWidth) / 2
  const hubRight = hubLeft + hubWidth
  const sources = rows(from.length).map((y, index) => ({ y, label: from[index]! }))
  const targets = rows(to.length).map((y, index) => ({ y, label: to[index]! }))
  const line = 'fill-none stroke-fd-muted-foreground/40'
  return (
    <svg
      role="img"
      aria-label={`${from.join(' and ')} through ${through} to ${to.join(', ')}`}
      viewBox={`0 0 ${width} ${height}`}
      // Capped so the labels stay near body-text size on wide cards.
      className="mx-auto h-auto w-full max-w-[26rem]"
    >
      {sources.map(({ y, label }) => (
        <path
          key={label}
          d={curve(edge + textWidth(label) + 22, y, hubLeft, middle)}
          className={line}
        />
      ))}
      {targets.map(({ y, label }) => (
        <path
          key={label}
          d={curve(hubRight, middle, width - edge - textWidth(label) - 22, y)}
          className={line}
        />
      ))}
      {sources.map(({ y, label }) => (
        <Node key={label} x={edge} y={y} label={label} />
      ))}
      <Node x={hubLeft} y={middle} label={through} hub />
      {targets.map(({ y, label }) => (
        <Node key={label} x={width - edge - textWidth(label) - 22} y={y} label={label} />
      ))}
    </svg>
  )
}
