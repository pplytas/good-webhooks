'use client'

import type { ReactNode, Ref } from 'react'
import { useCallback, useEffect, useId, useImperativeHandle, useRef } from 'react'

/**
 * The delivery path as a drawing you can run. One event leaves your app as a comet, slides
 * through PostgreSQL to the worker, and fans out to three receivers. Each receiver that answers
 * 200 sends a green ack back to the worker. One answers 503 and sends nothing back, so the worker
 * tries again, and this time it answers 200: the product's thesis in six seconds.
 *
 * The comet never fades in or out. It travels one continuous path drawn underneath the nodes,
 * which are opaque, so it is hidden while "inside" a node and emerges on the far side. Each node
 * tints while the comet is inside it and fades back to its resting border once it has left.
 *
 * Everything moves through the Web Animations API on stroke offsets and opacity, so the browser
 * composites it. Tints and status codes start from their current on-screen opacity, so a press
 * during a run never jumps. A press restarts the run: comets in flight vanish, and statuses and
 * tints fade back to rest before the new event leaves.
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
  /** How long a receiver holds its 200 before the ack leaves for the worker. */
  ackDelay: 150,
}

/** Tint left on a node after the comet has passed: none, the border returns to neutral. */
const visited = 0

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
  routes: { trunk: string; fan: [string, string, string]; ack: [string, string, string] }
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
      ack: rows.map(
        (row) =>
          `M${receiver} ${row} H${fanEnd(row).x} ${curve(fanEnd(row), fanStart, false)} H${worker}`,
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
      ack: columns.map(
        (column) =>
          `M${column} ${receiverY} V${fanEnd(column).y} ${curve(fanEnd(column), fanStart, true)} V${worker}`,
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
  /** Tint a node while the comet is inside it, then fade the tint out. */
  light: (node: NodeKey | number) => void
  /** Send the comet from your app to the worker. */
  trunk: () => void
  /** Send a comet from the worker to one receiver. */
  deliver: (receiver: number) => void
  /** Send a green ack from one receiver back to the worker. */
  ack: (receiver: number) => void
  status: (receiver: number, code: 200 | 503 | null) => void
  retrying: (on: boolean) => void
  /** Clear comets in flight and fade every tint and status back to rest. */
  reset: () => void
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

/** Tint fully while the comet is inside, then ease back out. */
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
const tones = {
  primary: ['stroke-fd-primary/25', 'stroke-fd-primary/60', 'stroke-fd-primary'],
  success: [
    'stroke-emerald-600/25 [.dark_&]:stroke-emerald-400/25',
    'stroke-emerald-600/60 [.dark_&]:stroke-emerald-400/60',
    'stroke-emerald-600 [.dark_&]:stroke-emerald-400',
  ],
} as const

function comet(
  layer: SVGGElement,
  route: string,
  stops: { at: number; position: number; easing?: string }[],
  tone: keyof typeof tones = 'primary',
) {
  // Only one stage is displayed per breakpoint. A hidden one still reports path lengths, so
  // check visibility directly rather than drawing comets nobody can see.
  if (!layer.checkVisibility()) return
  const probe = document.createElementNS(svgNS, 'path')
  probe.setAttribute('d', route)
  layer.append(probe)
  const length = probe.getTotalLength()
  probe.remove()
  if (!length) return
  const unit = 100 / length
  const duration = stops[stops.length - 1]!.at
  const [faint, soft, head] = tones[tone]
  const layers: { tail: number; width: number; className: string }[] = [
    { tail: 64 * unit, width: 2, className: faint },
    { tail: 28 * unit, width: 3, className: soft },
    { tail: 0.01, width: 6, className: head },
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
  const failures = useRef<Record<string, SVGRectElement | null>>({})
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
    ack: (receiver) => {
      if (!comets.current) return
      comet(
        comets.current,
        routes.ack[receiver]!,
        [
          { at: 0, position: 0, easing: glide },
          { at: timeline.crossing, position: 100 },
        ],
        'success',
      )
    },
    status: (receiver, code) => {
      fadeTo(statuses.current[`${receiver}-200`] ?? null, code === 200 ? 1 : 0)
      fadeTo(statuses.current[`${receiver}-503`] ?? null, code === 503 ? 1 : 0)
      fadeTo(failures.current[String(receiver)] ?? null, code === 503 ? 1 : 0)
    },
    retrying: (on) => {
      fadeTo(captions.current.sending ?? null, on ? 0 : 1)
      fadeTo(captions.current.retrying ?? null, on ? 1 : 0)
    },
    reset: () => {
      comets.current?.replaceChildren()
      for (const tint of Object.values(tints.current)) fadeTo(tint, 0, 150)
      receivers.forEach((_, index) => {
        fadeTo(statuses.current[`${index}-200`] ?? null, 0, 150)
        fadeTo(statuses.current[`${index}-503`] ?? null, 0, 150)
        fadeTo(failures.current[String(index)] ?? null, 0, 150)
      })
      fadeTo(captions.current.sending ?? null, 1, 150)
      fadeTo(captions.current.retrying ?? null, 0, 150)
    },
    settle: () => {
      for (const tint of Object.values(tints.current)) fadeTo(tint, visited, 0)
      receivers.forEach((_, index) => {
        fadeTo(statuses.current[`${index}-200`] ?? null, 1, 0)
        fadeTo(statuses.current[`${index}-503`] ?? null, 0, 0)
        fadeTo(failures.current[String(index)] ?? null, 0, 0)
      })
    },
  }))

  const box = (center: Pt, width: number, height: number) => ({
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
  })
  const line = 'fill-none stroke-fd-muted-foreground/40'
  const caption = 'fill-fd-muted-foreground font-mono text-[11px]'
  // Both layouts render on the page, so each needs its own marker id.
  const arrow = `arrow-${useId().replace(/:/g, '')}`

  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      className={`h-auto w-full ${className ?? ''}`}
    >
      <defs>
        <marker
          id={arrow}
          viewBox="0 0 6 8"
          markerWidth={6}
          markerHeight={8}
          refX={6}
          refY={4}
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M0 0L6 4L0 8Z" className="fill-fd-muted-foreground" />
        </marker>
      </defs>
      {/* Links, each with an arrowhead into the node it reaches, then comets, then the opaque
          nodes the comets hide behind. */}
      <path d={links.appDb} className={line} markerEnd={`url(#${arrow})`} />
      <path d={links.dbWorker} className={line} markerEnd={`url(#${arrow})`} />
      {links.fan.map((d) => (
        <path key={d} d={d} className={line} markerEnd={`url(#${arrow})`} />
      ))}
      <g ref={comets} className="motion-only" />

      {(
        [
          ['app', 'your app'],
          ['db', 'PostgreSQL'],
          ['worker', 'worker'],
        ] as const
      ).map(([key, label]) => {
        const rect = box(nodes[key], layout.nodeWidth, layout.nodeHeight)
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
        const rect = box(center, layout.receiverWidth, layout.receiverHeight)
        const statusX = rect.x + rect.width - 12
        return (
          <g key={index}>
            <rect {...rect} className="fill-fd-background stroke-fd-border" />
            <rect
              ref={(el) => {
                tints.current[String(index)] = el
              }}
              {...rect}
              className="fill-emerald-600/10 stroke-emerald-600/70 [.dark_&]:fill-emerald-400/10 [.dark_&]:stroke-emerald-400/70"
              opacity={0}
            />
            <rect
              ref={(el) => {
                failures.current[String(index)] = el
              }}
              {...rect}
              className="fill-red-400/10 stroke-red-400/70"
              opacity={0}
            />
            <text x={rect.x + 12} y={center.y} dy="0.35em" className={caption}>
              endpoint {'ABC'[index]}
            </text>
            <text
              ref={(el) => {
                statuses.current[`${index}-503`] = el
              }}
              x={statusX}
              y={center.y}
              dy="0.35em"
              textAnchor="end"
              className="fill-red-400 font-mono text-[11px]"
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
              className="fill-emerald-600 font-mono text-[11px] [.dark_&]:fill-emerald-400"
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
    const { stored, atWorker, sent, crossing, stagger, wait, ackDelay } = timeline

    // A press mid-run starts over: drop the old run's pending steps and clear the drawing.
    timers.current.forEach((timer) => clearTimeout(timer))
    timers.current.clear()
    each((s) => s.reset())

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
        if (receiver !== failed) each((s) => s.light(receiver))
        each((s) => s.status(receiver, receiver === failed ? 503 : 200))
      })
      if (receiver !== failed) {
        schedule(leaves + crossing + ackDelay, () => each((s) => s.ack(receiver)))
      }
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
    schedule(retry + crossing + ackDelay, () => each((s) => s.ack(failed)))
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
        // Wait until three quarters of the drawing is on screen (or of a screen shorter than it),
        // so a first run never plays half below the fold.
        const fits = Math.min(entry.boundingClientRect.height, window.innerHeight)
        if (entry.intersectionRect.height < fits * 0.75) return
        observer.disconnect()
        // A press before the drawing scrolled into view already started a run.
        if (runs.current === 0) schedule(600, run)
      },
      { threshold: Array.from({ length: 21 }, (_, i) => i / 20) },
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
    <div className="overflow-hidden border bg-fd-card">
      <div ref={drawing} className="relative px-4 pb-6 pt-14 sm:px-6 sm:pt-12">
        {/* A quiet control at the top left, where the eye enters the drawing; the hero buttons
            above stay the page's main actions. */}
        <button
          type="button"
          onClick={run}
          className="pressable absolute left-4 top-4 inline-flex h-8 items-center gap-1.5 border bg-fd-background pl-2.5 pr-3 text-xs font-medium text-fd-muted-foreground transition-[transform,color,background-color] duration-150 ease-out hover:bg-fd-accent hover:text-fd-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className="size-3.5 text-fd-primary"
            fill="currentColor"
          >
            <path d="M4.5 3.2a.75.75 0 0 1 1.14-.64l7 4.8a.75.75 0 0 1 0 1.28l-7 4.8A.75.75 0 0 1 4.5 12.8z" />
          </svg>
          Publish an event
        </button>
        <Stage ref={wideStage} layout={wide} className="hidden md:block" />
        <Stage ref={tallStage} layout={tall} className="mx-auto max-w-sm md:hidden" />
      </div>
      {children}
    </div>
  )
}
