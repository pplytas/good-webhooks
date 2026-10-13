'use client'

import type { ReactNode, Ref } from 'react'
import { useCallback, useEffect, useImperativeHandle, useRef } from 'react'

/**
 * The delivery path as a drawing you can run. One event leaves your app as a comet, slides
 * through PostgreSQL to the worker, and fans out to three receivers. One receiver answers 503,
 * the worker tries again, and it answers 200: the product's thesis in six seconds.
 *
 * The comet never fades in or out. It travels one continuous path drawn underneath the nodes,
 * which are opaque, so it is hidden while "inside" a node and emerges on the far side. Each node
 * tints while the comet is inside it and keeps a faint tint afterwards, so the finished frame
 * reads as the path the event took.
 *
 * Everything moves through the Web Animations API on stroke offsets and opacity, so the browser
 * composites it. Tints and status codes start from their current on-screen opacity, so a press
 * during a run never jumps. Runs overlap rather than restart: every press is its own event.
 *
 * Under prefers-reduced-motion nothing travels: the drawing parks on the resolved frame and a
 * run only crossfades tints and status codes. The step cells below carry the words.
 */

/** Ease-in-out for the comet: it leaves a node slowly and settles into the next. */
const glide = 'cubic-bezier(0.65, 0, 0.35, 1)'
const easeOut = 'cubic-bezier(0.23, 1, 0.32, 1)'
const easeInOut = 'cubic-bezier(0.77, 0, 0.175, 1)'

/** The run, in milliseconds from the press. */
const timeline = {
  /** The comet reaches the center of PostgreSQL. */
  stored: 800,
  /** It leaves PostgreSQL. */
  claimed: 1150,
  /** It reaches the center of the worker. */
  atWorker: 1950,
  /** The three deliveries leave the worker. */
  sent: 2300,
  /** Each delivery takes this long to cross to its receiver. */
  crossing: 800,
  /** Receivers leave in this order, this far apart. */
  stagger: 70,
  /** How long the failed receiver sits on 503 before the retry leaves. */
  wait: 1200,
}

/** Tint left on a node after the comet has passed. */
const visited = 0.4

type NodeKey = 'app' | 'db' | 'worker'
type Pt = { x: number; y: number }

type Layout = {
  width: number
  height: number
  nodeWidth: number
  nodeHeight: number
  receiverWidth: number
  receiverHeight: number
  nodes: Record<NodeKey, Pt>
  receivers: [Pt, Pt, Pt]
  /** The visible links, drawn from node edge to node edge. */
  links: { appDb: string; dbWorker: string; fan: [string, string, string] }
  /** The comet paths, extended straight into the node centers so the comet hides inside. */
  routes: { trunk: string; fan: [string, string, string] }
  captions: Record<'publish' | 'claim' | 'event' | 'worker', Pt & { anchor: 'start' | 'middle' }>
}

/** An S-curve with level tangents at both ends, so the straight node segments join smoothly. */
function curve(from: Pt, to: Pt, vertical: boolean) {
  const mid = vertical ? (from.y + to.y) / 2 : (from.x + to.x) / 2
  const c1 = vertical ? `${from.x} ${mid}` : `${mid} ${from.y}`
  const c2 = vertical ? `${to.x} ${mid}` : `${mid} ${to.y}`
  return `C${c1} ${c2} ${to.x} ${to.y}`
}

/** Four columns, for screens wide enough that 11px captions stay legible. */
const wide: Layout = (() => {
  const width = 960
  const height = 220
  const y = height / 2
  const nodeWidth = 150
  const nodeHeight = 44
  const receiverWidth = 150
  const receiverHeight = 30
  const [app, db, worker, receiver] = [120, 360, 600, 840]
  const rows = [40, y, 180] as const
  const half = nodeWidth / 2
  const fanStart = { x: worker + half, y }
  const fanEnd = (row: number) => ({ x: receiver - receiverWidth / 2, y: row })
  return {
    width,
    height,
    nodeWidth,
    nodeHeight,
    receiverWidth,
    receiverHeight,
    nodes: { app: { x: app, y }, db: { x: db, y }, worker: { x: worker, y } },
    receivers: rows.map((row) => ({ x: receiver, y: row })) as [Pt, Pt, Pt],
    links: {
      appDb: `M${app + half} ${y} H${db - half}`,
      dbWorker: `M${db + half} ${y} H${worker - half}`,
      fan: rows.map((row) => `M${fanStart.x} ${y} ${curve(fanStart, fanEnd(row), false)}`) as [
        string,
        string,
        string,
      ],
    },
    routes: {
      trunk: `M${app} ${y} H${worker}`,
      fan: rows.map(
        (row) =>
          `M${worker} ${y} H${fanStart.x} ${curve(fanStart, fanEnd(row), false)} H${receiver}`,
      ) as [string, string, string],
    },
    captions: {
      publish: { x: (app + db) / 2, y: y - 12, anchor: 'middle' },
      claim: { x: (db + worker) / 2, y: y - 12, anchor: 'middle' },
      event: { x: app, y: y + nodeHeight / 2 + 18, anchor: 'middle' },
      worker: { x: worker, y: y + nodeHeight / 2 + 18, anchor: 'middle' },
    },
  }
})()

/** The same scene stacked for phones: nodes down the middle, receivers across the bottom. */
const tall: Layout = (() => {
  const width = 384
  const height = 384
  const x = width / 2
  const nodeWidth = 150
  const nodeHeight = 44
  const receiverWidth = 120
  const receiverHeight = 30
  const [app, db, worker] = [40, 130, 220]
  const receiverY = height - 46
  const columns = [4 + receiverWidth / 2, x, width - 4 - receiverWidth / 2] as const
  const half = nodeHeight / 2
  const fanStart = { x, y: worker + half }
  const fanEnd = (column: number) => ({ x: column, y: receiverY - receiverHeight / 2 })
  return {
    width,
    height,
    nodeWidth,
    nodeHeight,
    receiverWidth,
    receiverHeight,
    nodes: { app: { x, y: app }, db: { x, y: db }, worker: { x, y: worker } },
    receivers: columns.map((column) => ({ x: column, y: receiverY })) as [Pt, Pt, Pt],
    links: {
      appDb: `M${x} ${app + half} V${db - half}`,
      dbWorker: `M${x} ${db + half} V${worker - half}`,
      fan: columns.map(
        (column) => `M${x} ${fanStart.y} ${curve(fanStart, fanEnd(column), true)}`,
      ) as [string, string, string],
    },
    routes: {
      trunk: `M${x} ${app} V${worker}`,
      fan: columns.map(
        (column) =>
          `M${x} ${worker} V${fanStart.y} ${curve(fanStart, fanEnd(column), true)} V${receiverY}`,
      ) as [string, string, string],
    },
    captions: {
      publish: { x: x + 12, y: (app + db) / 2 + 4, anchor: 'start' },
      claim: { x: x + 12, y: (db + worker) / 2 + 4, anchor: 'start' },
      event: { x: x + nodeWidth / 2 + 12, y: app + 4, anchor: 'start' },
      worker: { x: x + nodeWidth / 2 + 12, y: worker + 4, anchor: 'start' },
    },
  }
})()

type StageHandle = {
  /** Tint a node while the comet is inside it, then settle to the visited tint. */
  light: (node: NodeKey | number) => void
  /** Send the comet from your app to the worker. */
  trunk: () => void
  /** Send a comet from the worker to one receiver. */
  deliver: (receiver: number) => void
  status: (receiver: number, code: 200 | 503 | null) => void
  retrying: (on: boolean) => void
  /** Jump to the frame after a finished run, with nothing in flight. */
  settle: () => void
}

function opacityOf(el: Element) {
  return Number(getComputedStyle(el).opacity)
}

/** Fade from the current on-screen opacity, replacing any fade in progress. */
function fadeTo(el: Element | null, opacity: number, duration = 240) {
  if (!el) return
  const from = opacityOf(el)
  el.getAnimations().forEach((animation) => animation.cancel())
  el.animate([{ opacity: from }, { opacity }], { duration, easing: easeOut, fill: 'forwards' })
}

/** Tint fully while the comet is inside, then ease down to the visited tint. */
function lightUp(el: Element | null) {
  if (!el) return
  const from = opacityOf(el)
  el.getAnimations().forEach((animation) => animation.cancel())
  el.animate(
    [
      { opacity: from, offset: 0, easing: easeOut },
      { opacity: 1, offset: 0.2, easing: easeInOut },
      { opacity: 1, offset: 0.45, easing: easeInOut },
      { opacity: visited, offset: 1 },
    ],
    { duration: 1000, fill: 'forwards' },
  )
}

const svgNS = 'http://www.w3.org/2000/svg'

/**
 * A comet: a bright head and two softer tails, each a dash on a copy of the route, slid along it
 * by its dash offset. The route is normalised to 100 units, so `stops` are percentages of the
 * way along it. Tails are sized in pixels so they look the same on short and long routes.
 */
function comet(
  layer: SVGGElement,
  route: string,
  stops: { at: number; position: number; easing?: string }[],
) {
  const probe = document.createElementNS(svgNS, 'path')
  probe.setAttribute('d', route)
  layer.append(probe)
  const length = probe.getTotalLength()
  probe.remove()
  // A hidden stage (the other layout) measures zero: nothing to draw there.
  if (!length) return
  const unit = 100 / length
  const duration = stops[stops.length - 1]!.at
  const layers: { tail: number; width: number; className: string }[] = [
    { tail: 64 * unit, width: 2, className: 'stroke-fd-primary/25' },
    { tail: 28 * unit, width: 3, className: 'stroke-fd-primary/60' },
    { tail: 0.01, width: 6, className: 'stroke-fd-primary' },
  ]
  for (const { tail, width, className } of layers) {
    const path = document.createElementNS(svgNS, 'path')
    path.setAttribute('d', route)
    path.setAttribute('pathLength', '100')
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-width', String(width))
    path.setAttribute('stroke-dasharray', `${tail} 1000`)
    path.setAttribute('class', className)
    // The dash covers [p - tail, p] when the offset is tail - p.
    const offset = (position: number) => `${tail - position}`
    path.style.strokeDashoffset = offset(stops[0]!.position)
    layer.append(path)
    const animation = path.animate(
      stops.map((stop) => ({
        strokeDashoffset: offset(stop.position),
        offset: stop.at / duration,
        easing: stop.easing ?? 'linear',
      })),
      { duration, fill: 'forwards' },
    )
    animation.onfinish = () => path.remove()
  }
}

function Stage({
  layout,
  className,
  ref,
}: {
  layout: Layout
  className?: string
  ref: Ref<StageHandle>
}) {
  const tints = useRef<Record<string, SVGRectElement | null>>({})
  const statuses = useRef<Record<string, SVGTextElement | null>>({})
  const captions = useRef<Record<string, SVGTextElement | null>>({})
  const comets = useRef<SVGGElement>(null)
  const { nodes, receivers, links, routes, captions: at } = layout

  useImperativeHandle(ref, () => ({
    light: (node) => lightUp(tints.current[String(node)] ?? null),
    trunk: () => {
      if (!comets.current) return
      // Center of your app → center of PostgreSQL (halfway) → pause inside → center of the worker.
      comet(comets.current, routes.trunk, [
        { at: 0, position: 0, easing: glide },
        { at: timeline.stored, position: 50 },
        { at: timeline.claimed, position: 50, easing: glide },
        { at: timeline.atWorker, position: 100 },
      ])
    },
    deliver: (receiver) => {
      if (!comets.current) return
      comet(comets.current, routes.fan[receiver]!, [
        { at: 0, position: 0, easing: glide },
        { at: timeline.crossing, position: 100 },
      ])
    },
    status: (receiver, code) => {
      fadeTo(statuses.current[`${receiver}-200`] ?? null, code === 200 ? 1 : 0)
      fadeTo(statuses.current[`${receiver}-503`] ?? null, code === 503 ? 1 : 0)
    },
    retrying: (on) => {
      fadeTo(captions.current.sending ?? null, on ? 0 : 1)
      fadeTo(captions.current.retrying ?? null, on ? 1 : 0)
    },
    settle: () => {
      for (const tint of Object.values(tints.current)) fadeTo(tint, visited, 0)
      receivers.forEach((_, index) => {
        fadeTo(statuses.current[`${index}-200`] ?? null, 1, 0)
        fadeTo(statuses.current[`${index}-503`] ?? null, 0, 0)
      })
    },
  }))

  const markerId = `delivery-arrow-${layout.width}`
  const box = (center: Pt, width: number, height: number, rx: number) => ({
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
    rx,
  })
  const line = 'fill-none stroke-fd-muted-foreground/40'
  const caption = 'fill-fd-muted-foreground font-mono text-[11px]'

  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      className={`h-auto w-full ${className ?? ''}`}
    >
      <defs>
        <marker
          id={markerId}
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0 0.5 L7 4 L0 7.5" className="fill-none stroke-fd-muted-foreground/60" />
        </marker>
      </defs>

      {/* Links, then comets, then the opaque nodes the comets hide behind. */}
      <path d={links.appDb} className={line} markerEnd={`url(#${markerId})`} />
      <path d={links.dbWorker} className={line} markerEnd={`url(#${markerId})`} />
      {links.fan.map((d) => (
        <path key={d} d={d} className={line} markerEnd={`url(#${markerId})`} />
      ))}
      <g ref={comets} className="motion-only" />

      {(
        [
          ['app', 'your app'],
          ['db', 'PostgreSQL'],
          ['worker', 'worker'],
        ] as const
      ).map(([key, label]) => {
        const rect = box(nodes[key], layout.nodeWidth, layout.nodeHeight, 10)
        return (
          <g key={key}>
            <rect {...rect} className="fill-fd-background stroke-fd-border" />
            <rect
              ref={(el) => {
                tints.current[key] = el
              }}
              {...rect}
              className="fill-fd-primary/10 stroke-fd-primary"
              opacity={0}
            />
            <text
              x={nodes[key].x}
              y={nodes[key].y}
              dy="0.35em"
              textAnchor="middle"
              className="fill-fd-foreground font-sans text-[13px] font-medium"
            >
              {label}
            </text>
          </g>
        )
      })}

      {receivers.map((center, index) => {
        const rect = box(
          center,
          layout.receiverWidth,
          layout.receiverHeight,
          layout.receiverHeight / 2,
        )
        const statusX = rect.x + rect.width - 12
        return (
          <g key={index}>
            <rect {...rect} className="fill-fd-background stroke-fd-border" />
            <rect
              ref={(el) => {
                tints.current[String(index)] = el
              }}
              {...rect}
              className="fill-fd-primary/10 stroke-fd-primary"
              opacity={0}
            />
            <text x={rect.x + 12} y={center.y} dy="0.35em" className={caption}>
              customer {'ABC'[index]}
            </text>
            <text
              ref={(el) => {
                statuses.current[`${index}-503`] = el
              }}
              x={statusX}
              y={center.y}
              dy="0.35em"
              textAnchor="end"
              className={caption}
              opacity={0}
            >
              503
            </text>
            <text
              ref={(el) => {
                statuses.current[`${index}-200`] = el
              }}
              x={statusX}
              y={center.y}
              dy="0.35em"
              textAnchor="end"
              className="fill-fd-primary font-mono text-[11px]"
              opacity={0}
            >
              200
            </text>
          </g>
        )
      })}

      <text x={at.publish.x} y={at.publish.y} textAnchor={at.publish.anchor} className={caption}>
        publish()
      </text>
      <text x={at.claim.x} y={at.claim.y} textAnchor={at.claim.anchor} className={caption}>
        claim due
      </text>
      <text x={at.event.x} y={at.event.y} textAnchor={at.event.anchor} className={caption}>
        invoice.paid
      </text>
      <text
        ref={(el) => {
          captions.current.sending = el
        }}
        x={at.worker.x}
        y={at.worker.y}
        textAnchor={at.worker.anchor}
        className={caption}
      >
        signed POST
      </text>
      <text
        ref={(el) => {
          captions.current.retrying = el
        }}
        x={at.worker.x}
        y={at.worker.y}
        textAnchor={at.worker.anchor}
        className="fill-fd-primary font-mono text-[11px]"
        opacity={0}
      >
        retry
      </text>
    </svg>
  )
}

export function Delivery({ children }: { children?: ReactNode }) {
  const wideStage = useRef<StageHandle>(null)
  const tallStage = useRef<StageHandle>(null)
  const drawing = useRef<HTMLDivElement>(null)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const runs = useRef(0)

  const schedule = useCallback((ms: number, fn: () => void) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      fn()
    }, ms)
    timers.current.add(timer)
  }, [])

  const run = useCallback(() => {
    const failed = runs.current++ % 3
    const each = (fn: (stage: StageHandle) => void) =>
      [wideStage.current, tallStage.current].forEach((stage) => stage && fn(stage))
    const { stored, atWorker, sent, crossing, stagger, wait } = timeline

    each((s) => s.light('app'))
    each((s) => s.trunk())
    schedule(stored, () => {
      each((s) => s.light('db'))
    })
    schedule(atWorker, () => each((s) => s.light('worker')))
    schedule(sent, () => {
      each((s) => [0, 1, 2].forEach((r) => s.status(r, null)))
    })
    for (const receiver of [0, 1, 2]) {
      const leaves = sent + receiver * stagger
      schedule(leaves, () => each((s) => s.deliver(receiver)))
      schedule(leaves + crossing, () => {
        each((s) => s.light(receiver))
        each((s) => s.status(receiver, receiver === failed ? 503 : 200))
      })
    }
    const retry = sent + failed * stagger + crossing + wait
    schedule(retry - 200, () => {
      each((s) => s.retrying(true))
      each((s) => s.light('worker'))
    })
    schedule(retry, () => each((s) => s.deliver(failed)))
    schedule(retry + crossing, () => {
      each((s) => s.light(failed))
      each((s) => s.status(failed, 200))
    })
    schedule(retry + crossing + 1000, () => each((s) => s.retrying(false)))
  }, [schedule])

  useEffect(() => {
    const el = drawing.current
    if (!el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      ;[wideStage.current, tallStage.current].forEach((stage) => stage?.settle())
      runs.current = 1
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return
        observer.disconnect()
        schedule(600, run)
      },
      { threshold: 0.4 },
    )
    observer.observe(el)
    const pending = timers.current
    return () => {
      observer.disconnect()
      pending.forEach((timer) => clearTimeout(timer))
      pending.clear()
    }
  }, [run, schedule])

  return (
    <div className="overflow-hidden rounded-xl border bg-fd-card">
      <div ref={drawing} className="px-4 pt-4 sm:px-6 sm:pt-5">
        <Stage ref={wideStage} layout={wide} className="hidden md:block" />
        <Stage ref={tallStage} layout={tall} className="mx-auto max-w-sm md:hidden" />
      </div>
      <div className="px-4 pb-4 pt-3 sm:px-6 sm:pb-5">
        <button
          type="button"
          onClick={run}
          className="pressable inline-flex h-9 items-center gap-2 rounded-full bg-fd-primary pl-3 pr-4 text-sm font-medium text-fd-primary-foreground transition-[transform,background-color] duration-150 ease-out hover:bg-fd-primary/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring focus-visible:ring-offset-2 focus-visible:ring-offset-fd-card"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="currentColor">
            <path d="M4.5 3.2a.75.75 0 0 1 1.14-.64l7 4.8a.75.75 0 0 1 0 1.28l-7 4.8A.75.75 0 0 1 4.5 12.8z" />
          </svg>
          Publish an event
        </button>
      </div>
      {children}
    </div>
  )
}
