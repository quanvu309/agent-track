import { type KeyboardEvent, useRef, useState } from "react"

import { TimeTicks } from "@/components/session-viz"
import { StatusIcon } from "@/components/status-icon"
import { compact, dur, fmt, when } from "@/lib/format"
import { STATUS, statusOf } from "@/lib/fleet"
import { harnessMeta } from "@/lib/harness"
import { useNow } from "@/lib/session-now"
import { useWidth } from "@/lib/session-use-width"
import type { ThreadNode } from "@/lib/session-format"
import { at, packLanes, timeTicks } from "@/lib/session-layout"

const PITCH = 12
const BAR = 6
const ROOT_BAR = 8
const BAND_GAP = 10
const PAD = 6
const MIN_W = 3
const LANE_GAP_PX = 4
const LABEL_W = 160
const ICON_ROOM = 18
const TIP_W = 216

type Placed = { node: ThreadNode; start: number; end: number; row: number }

const bandLabel = (depth: number) => (depth === 0 ? "Main thread" : depth === 1 ? "Sub-agents" : "Nested sub-agents")

/** Every thread as a bar from its first to its last activity. The main thread runs along the top, sub-agents sit below by depth, and a hairline joins each to the thread that started it. */
export function ThreadForks({ tree, harness }: { tree: ThreadNode[]; harness: string }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const now = useNow()
  const [hover, setHover] = useState<number | null>(null)
  const [stop, setStop] = useState(0)
  const bars = useRef<(SVGGElement | null)[]>([])
  const color = harnessMeta(harness).color
  const timed = tree.filter((t) => t.started_at)
  if (timed.length < 2) return null
  const spans = timed.map((t) => {
    const start = Date.parse(t.started_at!)
    return { start, end: t.last ? Math.max(start, Date.parse(t.last)) : start }
  })
  const domain = { start: Math.min(...spans.map((s) => s.start)), end: Math.max(...spans.map((s) => s.end)) }
  const labelW = width >= 520 ? LABEL_W : 0
  const plotW = Math.max(0, width - labelW)
  const drawW = Math.max(0, plotW - ICON_ROOM)
  const timeGap = drawW ? ((domain.end - domain.start) * LANE_GAP_PX) / drawW : 0
  const depths = [...new Set(timed.map((t) => t.depth))].sort((a, b) => a - b)
  const placed: Placed[] = []
  const bandRow = new Map<number, number>()
  let rowBase = 0
  for (const depth of depths) {
    const idx = timed.map((t, i) => (t.depth === depth ? i : -1)).filter((i) => i >= 0)
    const { lanes, count } = packLanes(idx.map((i) => spans[i]), timeGap)
    idx.forEach((i, k) => placed.push({ node: timed[i], ...spans[i], row: rowBase + lanes[k] }))
    bandRow.set(depth, rowBase)
    rowBase += count
  }
  const bandTop = (depth: number) => PAD + bandRow.get(depth)! * PITCH + depths.indexOf(depth) * BAND_GAP
  const yOf = (p: Placed) => PAD + p.row * PITCH + depths.indexOf(p.node.depth) * BAND_GAP + PITCH / 2
  const height = rowBase * PITCH + (depths.length - 1) * BAND_GAP + PAD * 2
  const x = (t: number) => at(domain, t) * drawW
  const barX = (p: Placed) => Math.min(x(p.start), drawW - MIN_W)
  const barW = (p: Placed) => Math.max(MIN_W, x(p.end) - x(p.start))
  const byId = new Map(placed.map((p) => [p.node.thread_id, p]))
  const hovered = hover === null ? null : placed[hover]
  const ticks = timeTicks(domain, drawW < 480 ? 3 : 6)
  const nameOf = (p: Placed) => `${p.node.name}, ${STATUS[statusOf(p.node, now)].label}, ${fmt(p.node.tool_calls)} tool calls, ran ${dur((p.end - p.start) / 1000)}`

  const move = (e: KeyboardEvent, i: number) => {
    const to = e.key === "ArrowDown" || e.key === "ArrowRight" ? i + 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? placed.length - 1 : null
    if (to === null || to < 0 || to >= placed.length) return
    e.preventDefault()
    setStop(to)
    bars.current[to]?.focus()
  }

  const tipLeft = hovered ? Math.max(0, Math.min(plotW - TIP_W, labelW + x(hovered.start) + barW(hovered) / 2 - TIP_W / 2)) : 0
  const tipY = hovered ? yOf(hovered) : 0
  const tipBelow = tipY < 150

  return (
    <div className="grid min-w-0 gap-2">
      <div ref={ref} className="relative w-full rounded-lg border px-3 pt-0 pb-2" onPointerLeave={() => setHover(null)}>
        {width ? (
          <>
            <div className="relative" style={{ height }}>
              {labelW ? (
                <div aria-hidden className="absolute inset-y-0 left-0" style={{ width: labelW }}>
                  {depths.map((d) => (
                    <div
                      key={d}
                      className={d === 0 ? "absolute inset-x-0 truncate pr-3 text-xs leading-3 font-medium text-foreground" : "absolute inset-x-0 truncate pr-3 text-xs leading-3 text-muted-foreground"}
                      style={{ top: bandTop(d) + (PITCH - 12) / 2 }}
                    >
                      {bandLabel(d)}
                      {d > 0 ? <span className="tabular-nums"> · {fmt(timed.filter((t) => t.depth === d).length)}</span> : null}
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="absolute inset-y-0 right-0" style={{ width: plotW }}>
                <svg
                  width={plotW}
                  height={height}
                  role="group"
                  aria-label={`${fmt(timed.length)} threads over ${dur((domain.end - domain.start) / 1000)}`}
                  className="block overflow-visible"
                >
                  {ticks.map((k) => (
                    <line key={k.t} x1={Math.round(x(k.t)) + 0.5} x2={Math.round(x(k.t)) + 0.5} y1={0} y2={height} stroke="var(--border)" />
                  ))}
                  {depths.slice(1).map((d) => (
                    <line key={`b${d}`} x1={0} x2={plotW} y1={bandTop(d) - BAND_GAP / 2} y2={bandTop(d) - BAND_GAP / 2} stroke="var(--border)" />
                  ))}
                  {placed.map((p) => {
                    const parent = p.node.parent_thread_id ? byId.get(p.node.parent_thread_id) : undefined
                    if (!parent) return null
                    const cx = Math.round(x(p.start)) + 0.5
                    return <line key={`l${p.node.thread_id}`} x1={cx} x2={cx} y1={yOf(parent)} y2={yOf(p)} stroke="var(--border-strong)" />
                  })}
                  {placed.map((p, i) => {
                    const h = p.node.depth === 0 ? ROOT_BAR : BAR
                    return (
                      <g
                        key={p.node.thread_id}
                        ref={(el) => {
                          bars.current[i] = el
                        }}
                        tabIndex={i === stop ? 0 : -1}
                        role="img"
                        aria-label={nameOf(p)}
                        style={{ outline: "none" }}
                        onPointerEnter={() => setHover(i)}
                        onPointerDown={() => setHover(i)}
                        onFocus={() => {
                          setStop(i)
                          setHover(i)
                        }}
                        onBlur={() => setHover((v) => (v === i ? null : v))}
                        onKeyDown={(e) => move(e, i)}
                      >
                        <rect x={barX(p) - 3} y={yOf(p) - PITCH / 2} width={barW(p) + 6} height={PITCH} fill="transparent" />
                        <rect
                          x={barX(p)}
                          y={yOf(p) - h / 2}
                          width={barW(p)}
                          height={h}
                          rx={h / 2}
                          fill={color}
                          fillOpacity={p.node.depth === 0 ? 1 : 0.55}
                          stroke={hover === i ? "var(--foreground)" : "none"}
                          strokeWidth={1.5}
                        />
                      </g>
                    )
                  })}
                </svg>
                {placed.map((p) =>
                  statusOf(p.node, now) === "working" ? (
                    <span key={`w${p.node.thread_id}`} aria-hidden className="pointer-events-none absolute" style={{ left: barX(p) + barW(p) + 4, top: yOf(p) - 5 }}>
                      <StatusIcon status="working" size={10} label={false} />
                    </span>
                  ) : null,
                )}
              </div>
            </div>
            <div style={{ marginLeft: labelW, width: drawW }}>
              <TimeTicks ticks={ticks} pos={(t) => at(domain, t)} />
            </div>
            {hovered ? (
              <div
                aria-hidden
                role="tooltip"
                className="pointer-events-none absolute z-20 grid grid-cols-[minmax(0,1fr)] gap-1.5 rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg"
                style={{ left: tipLeft + 12, width: TIP_W, ...(tipBelow ? { top: tipY + 16 } : { bottom: `calc(100% - ${tipY}px + 6px)` }) }}
              >
                <div className="flex items-center gap-2 font-medium text-foreground">
                  <StatusIcon status={statusOf(hovered.node, now)} size={10} label={false} />
                  <span className="min-w-0 truncate">{hovered.node.name}</span>
                </div>
                {[
                  ["Status", STATUS[statusOf(hovered.node, now)].label],
                  ["Model", hovered.node.model ?? "unknown"],
                  ["Started", when(hovered.node.started_at)],
                  ["Ran", dur((hovered.end - hovered.start) / 1000)],
                  ["Tool calls", fmt(hovered.node.tool_calls)],
                  ["Tokens", `in ${compact(hovered.node.input_tokens)} · out ${compact(hovered.node.output_tokens)}`],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-baseline justify-between gap-3">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="min-w-0 truncate font-medium text-foreground tabular-nums">{value}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <div style={{ height: height + 16 }} />
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Each bar runs from a thread's first to its last activity. Lines link a sub-agent to the thread that started it.
      </p>
    </div>
  )
}
