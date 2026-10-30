import { type KeyboardEvent, useMemo, useState } from "react"
import { cn } from "cn"

import { Surface, TimelineSkeleton } from "@/components/control-center-parts"
import { StatusIcon } from "@/components/status-icon"
import { Tip, TimeTicks } from "@/components/session-viz"
import { type BoardSession, STATUS, type TimelineLane, timelineLanes } from "@/lib/fleet"
import { compact, dur, fmt, when } from "@/lib/format"
import { harnessMeta } from "@/lib/harness"
import { since } from "@/lib/now-time"
import { at, timeTicks } from "@/lib/session-layout"
import { displayTitle } from "@/lib/session-title"
import { useWidth } from "@/lib/session-use-width"
import { useMedia } from "@/lib/use-media"
import { HarnessDot } from "@/components/kit"

const LABEL_W = 240
const NARROW_LABEL_H = 44
const ROOT_H = 6
const SUB_H = 4
const SUB_PITCH = 8
const MIN_BAR = 3
const CAP = 12
const MD = "(min-width: 768px)"

type Active = { sid: string; tid: string }

const laneTop = (wide: boolean) => (wide ? 14 : 9)

function laneHeight(lane: TimelineLane, wide: boolean) {
  const content = laneTop(wide) + ROOT_H + (lane.subRows ? 5 + lane.subRows * SUB_PITCH : 0) + 9
  return Math.max(wide ? 44 : 24, content)
}

type Bar = { id: string; start: number; end: number; y: number; h: number; depth: number; parent: string | null; node: TimelineLane["children"][number]["node"] | null }

/** The bars of one lane with their y centre: the main thread first, then each sub-agent on its sub-row. */
function barsOf(lane: TimelineLane, wide: boolean): Bar[] {
  const top = laneTop(wide)
  const rootId = lane.session.row.session_id
  const root: Bar = { id: rootId, ...lane.root, y: top + ROOT_H / 2, h: ROOT_H, depth: 0, parent: null, node: null }
  const kids = [...lane.children]
    .sort((a, b) => a.start - b.start)
    .map((c): Bar => ({
      id: c.node.thread_id, start: c.start, end: c.end, y: top + ROOT_H + 5 + c.lane * SUB_PITCH + SUB_H / 2, h: SUB_H, depth: c.depth, parent: c.node.parent_thread_id, node: c.node,
    }))
  return [root, ...kids]
}

const WINDOW_MS = 60 * 60_000

export type TimelineProps = {
  groups: { sessions: BoardSession[] }[]
  now: number
  onOpen: (sessionId: string) => void
  names: (project: string | null) => string
  loading: boolean
  failed: string | null
  open: boolean
  onToggle: () => void
}

export function TimelinePanel({ groups, now, onOpen, names, loading, failed, open, onToggle }: TimelineProps) {
  const wide = useMedia(MD)
  const [ref, width] = useWidth<HTMLDivElement>()
  const [all, setAll] = useState(false)
  const [active, setActive] = useState<Active | null>(null)
  const domain = useMemo(() => ({ start: now - WINDOW_MS, end: now }), [now])
  const lanes = useMemo(() => timelineLanes(groups, domain, width ? (WINDOW_MS * 4) / width : 0), [groups, domain, width])
  const ticks = useMemo(() => (width ? timeTicks(domain, Math.max(3, Math.floor(width / 90))).filter((k) => at(domain, k.t) < 0.92) : []), [domain, width])
  const shown = all ? lanes : lanes.slice(0, CAP)
  const cols = wide ? { gridTemplateColumns: `${LABEL_W}px minmax(0,1fr)` } : undefined

  return (
    <Surface
      title="Timeline"
      description={"Live threads over the last hour"}
      collapse={{ open, onToggle }}
    >
      <div className="pb-2">
        <div className="grid items-end px-4 pt-2 pb-1" style={cols}>
          {wide ? <span className="text-[11px] text-muted-foreground">Session</span> : null}
          <div ref={ref} className="relative h-4">
            <TimeTicks ticks={ticks} pos={(t) => at(domain, t)} />
            <span aria-hidden className="absolute top-0 right-0 text-[11px] leading-4 font-medium text-foreground">now</span>
          </div>
        </div>
        {loading ? (
          <TimelineSkeleton wide={wide} />
        ) : failed ? (
          <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">Couldn't load sessions: {failed}</p>
        ) : !lanes.length ? (
          <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">Nothing is running</p>
        ) : (
          <>
            <ul aria-label={"Live sessions, working first"} className="grid">
              {shown.map((lane, i) => (
                <LaneRow
                  key={lane.session.row.session_id}
                  lane={lane}
                  index={i}
                  wide={wide}
                  width={width}
                  domain={domain}
                  tickTimes={ticks.map((k) => k.t)}
                  name={names(lane.session.row.project)}
                  now={now}
                  active={active?.sid === lane.session.row.session_id ? active.tid : null}
                  setActive={setActive}
                  onOpen={onOpen}
                />
              ))}
            </ul>
            {lanes.length > CAP ? (
              <div className="px-4 pt-1" style={wide ? { paddingLeft: 16 + LABEL_W - 8 } : undefined}>
                <button
                  type="button"
                  aria-expanded={all}
                  onClick={() => setAll((v) => !v)}
                  className="h-9 lg:h-8 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:bg-raised hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  {all ? `Show the first ${CAP}` : `Show all ${fmt(lanes.length)}`}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Surface>
  )
}

function LaneRow({ lane, index, wide, width, domain, tickTimes, name, now, active, setActive, onOpen }: {
  lane: TimelineLane
  index: number
  wide: boolean
  width: number
  domain: { start: number; end: number }
  tickTimes: number[]
  name: string
  now: number
  active: string | null
  setActive: (a: Active | null) => void
  onOpen: (id: string) => void
}) {
  const { session } = lane
  const { row } = session
  const color = harnessMeta(row.harness).color
  const title = displayTitle(row.title)
  const bars = useMemo(() => barsOf(lane, wide), [lane, wide])
  const height = laneHeight(lane, wide)
  const x = (t: number) => at(domain, t) * width
  const place = (b: Bar) => {
    const w = Math.max(MIN_BAR, x(b.end) - x(b.start))
    return { x0: Math.max(0, Math.min(x(b.start), width - w)), w }
  }
  const byId = new Map(bars.map((b) => [b.id, b]))
  const statusOf = (b: Bar) => (b.node ? b.node.status : session.status)
  const labelOffset = wide ? 0 : NARROW_LABEL_H
  const shownBar = bars.find((b) => b.id === active) ?? null
  const shownAt = shownBar ? place(shownBar) : null

  const step = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Escape") return setActive(null)
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return
    e.preventDefault()
    const at0 = Math.max(0, bars.findIndex((b) => b.id === active))
    const next = bars[(at0 + (e.key === "ArrowRight" ? 1 : bars.length - 1)) % bars.length]
    setActive({ sid: row.session_id, tid: next.id })
  }

  const tipFor = (b: Bar) => {
    const node = b.node
    const started = node ? node.started_at : (row.first ?? row.started)
    const lastAt = node ? node.last : row.last
    const ran = started && lastAt ? Math.max(0, (Date.parse(lastAt) - Date.parse(started)) / 1000) : 0
    const model = node ? node.model : session.model
    return {
      title: (
        <span className="grid min-w-0 gap-0.5">
          <span className="line-clamp-2 break-words">{node ? node.name : title.text}</span>
          <span className="flex min-w-0 items-center gap-1.5 font-normal text-muted-foreground">
            <StatusIcon status={statusOf(b)} size={10} label={false} />
            <span className="shrink-0">{STATUS[statusOf(b)].label}</span>
            {model ? <span className="min-w-0 truncate">· {model}</span> : null}
          </span>
        </span>
      ),
      lines: [
        { label: "Started", value: when(started) },
        { label: "Ran", value: dur(ran) },
        { label: "Tool calls", value: fmt(node ? node.tool_calls : row.tool_calls), strong: true },
        { label: "Input", value: compact(node ? node.input_tokens : row.input_tokens) },
        { label: "Output", value: compact(node ? node.output_tokens : row.output_tokens) },
      ],
    }
  }

  const label = `${title.text}, ${STATUS[session.status].label}, ${harnessMeta(row.harness).label}, ${name}, ${session.subagents.length} sub-agents, last ${since(row.last, now)}`
  const tip = shownBar && shownAt ? tipFor(shownBar) : null

  return (
    <li className="group/lane relative px-4 transition-colors duration-150 ease-out hover:bg-raised/60 has-[:focus-visible]:bg-raised/60" onPointerLeave={() => setActive(null)}>
      <div className="grid" style={wide ? { gridTemplateColumns: `${LABEL_W}px minmax(0,1fr)` } : undefined}>
        <button
          type="button"
          aria-label={label}
          title={row.title ?? undefined}
          onClick={() => onOpen(row.session_id)}
          onFocus={() => setActive({ sid: row.session_id, tid: row.session_id })}
          onBlur={() => setActive(null)}
          onKeyDown={step}
          className={cn(
            "group/label grid min-w-0 content-start gap-0.5 rounded-md text-left outline-offset-[-2px] disabled:pointer-events-none disabled:opacity-50",
            wide ? "pt-2 pr-3" : "pt-2",
          )}
          style={wide ? undefined : { height: NARROW_LABEL_H }}
        >
          <span className="flex min-w-0 items-center gap-2">
            <StatusIcon status={session.status} label={false} />
            <span className={cn("truncate text-[13px] leading-[18px] font-medium", title.muted ? "text-muted-foreground" : "text-foreground")}>{title.text}</span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 pl-[22px] text-xs leading-4 text-muted-foreground">
            <HarnessDot id={row.harness} className="size-2" />
            <span className="shrink-0">{harnessMeta(row.harness).label}</span>
            <span aria-hidden>·</span>
            <span className="truncate">{name}</span>
          </span>
        </button>
        <div className="relative" style={{ height }}>
          {width ? (
            <svg width={width} height={height} aria-hidden className="block overflow-visible">
              {tickTimes.map((t) => <line key={t} x1={Math.round(x(t)) + 0.5} x2={Math.round(x(t)) + 0.5} y1={0} y2={height} stroke="var(--border)" />)}
              <line x1={width - 0.5} x2={width - 0.5} y1={0} y2={height} stroke="var(--brand)" strokeOpacity={0.7} />
              {wide
                ? bars.slice(1).map((b) => {
                    if (at(domain, b.start) <= 0) return null
                    const parent = (b.parent && byId.get(b.parent)) || bars[0]
                    const cx = Math.round(x(b.start)) + 0.5
                    return <line key={`c${b.id}`} x1={cx} x2={cx} y1={parent.y} y2={b.y} stroke="var(--foreground)" strokeOpacity={0.2} />
                  })
                : null}
              {bars.map((b) => {
                const p = place(b)
                const dim = statusOf(b) === "ended" ? 0.6 : 1
                return (
                  <rect
                    key={b.id}
                    x={p.x0}
                    y={b.y - b.h / 2}
                    width={p.w}
                    height={b.h}
                    rx={b.h / 2}
                    fill={color}
                    fillOpacity={(b.depth === 0 && !b.node ? 1 : 0.55) * dim}
                    stroke={active === b.id ? "var(--foreground)" : "none"}
                    strokeWidth={1}
                  />
                )
              })}
              {bars.map((b) => {
                const p = place(b)
                return (
                  <rect
                    key={`h${b.id}`}
                    x={p.x0 - 2}
                    y={b.y - SUB_PITCH / 2 - 1}
                    width={p.w + 4}
                    height={SUB_PITCH + 2}
                    fill="transparent"
                    className="cursor-pointer"
                    onPointerEnter={() => setActive({ sid: row.session_id, tid: b.id })}
                    onClick={() => onOpen(row.session_id)}
                  />
                )
              })}
            </svg>
          ) : null}
          {width
            ? bars.filter((b) => statusOf(b) === "working").map((b) => {
                const p = place(b)
                return (
                  <span key={`g${b.id}`} className="pointer-events-none absolute rounded-full bg-card ring-2 ring-card" style={{ left: p.x0 + p.w - 5, top: b.y, transform: "translate(-50%,-50%)" }}>
                    <StatusIcon status="working" size={b.node ? 8 : 10} label={false} />
                  </span>
                )
              })
            : null}
        </div>
      </div>
      {tip && shownBar && shownAt ? (
        <Tip
          x={16 + (wide ? LABEL_W : 0) + shownAt.x0 + shownAt.w / 2}
          y={labelOffset + shownBar.y + (shownBar.h / 2)}
          width={width + (wide ? LABEL_W : 0) + 32}
          title={tip.title}
          lines={tip.lines}
          below={index < 5}
        />
      ) : null}
    </li>
  )
}
