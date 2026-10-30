import { useState } from "react"
import { cn } from "cn"

import { NowLine, PLOT_LEFT, PLOT_RIGHT } from "@/components/now-chart"
import { dur, fmt, pad2, shortPath } from "@/lib/format"
import { harnessMeta } from "@/lib/harness"
import { CAP, type Lane, clip, lanesNote, pick, toLanes } from "@/lib/now-sessions"
import { dayHours } from "@/lib/now-time"
import type { SessionRow } from "@/lib/types"

const GRID = [0, 3, 6, 9, 12, 15, 18, 21, 24]

const clock = (h: number) => `${pad2(Math.floor(h))}:${pad2(Math.floor((h % 1) * 60))}`
const at = (h: number) => `${(h / 24) * 100}%`

export function Pulse({ harness, fresh }: { harness: string; fresh: boolean }) {
  const color = harnessMeta(harness).color
  return (
    <span aria-hidden className="relative flex size-2.5 shrink-0">
      {fresh ? <span className="absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping" style={{ background: color }} /> : null}
      <span className="relative size-2.5 rounded-full" style={{ background: color }} />
    </span>
  )
}

function LaneTip({ lane, below }: { lane: Lane; below: boolean }) {
  return (
    <div
      role="tooltip"
      className={cn("pointer-events-none absolute z-20 grid w-64 gap-1.5 rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg", below ? "top-full mt-1" : "bottom-full mb-1")}
      style={{ left: `clamp(0px, calc(${PLOT_LEFT}px + (100% - ${PLOT_LEFT + PLOT_RIGHT}px) * ${(lane.start + lane.end) / 48} - 8rem), calc(100% - 16rem))` }}
    >
      <div className={cn("line-clamp-2 font-medium", lane.title.muted ? "text-muted-foreground" : "text-foreground")}>{lane.title.text}</div>
      <div className="truncate text-muted-foreground">{harnessMeta(lane.harness).label} · {shortPath(lane.project)}</div>
      <TipRow label={`${clock(lane.start)} to ${lane.live ? "now" : clock(lane.end)}`} value={`${dur(lane.activeS)} active`} />
      <TipRow label="Tool calls" value={fmt(lane.toolCalls)} />
    </div>
  )
}

function TipRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground tabular-nums">{label}</span>
      <span className="font-medium text-foreground tabular-nums">{value}</span>
    </div>
  )
}

function LaneRow({ lane, tipBelow, hovered, onHover, onOpen }: {
  lane: Lane
  tipBelow: boolean
  hovered: boolean
  onHover: (id: string | null) => void
  onOpen: (id: string) => void
}) {
  const { start, end } = lane
  // Titles hang off whichever end of the bar has more of the day left to fill.
  const fromStart = start + end < 24
  return (
    <li className="relative">
      <button
        type="button"
        onClick={() => onOpen(lane.id)}
        onPointerEnter={(e) => e.pointerType === "mouse" && onHover(lane.id)}
        onPointerLeave={() => onHover(null)}
        onFocus={() => onHover(lane.id)}
        onBlur={() => onHover(null)}
        aria-label={`${lane.title.text}, ${harnessMeta(lane.harness).label}, ${clock(start)} to ${lane.live ? "now" : clock(end)}, ${dur(lane.activeS)} active, ${fmt(lane.toolCalls)} tool calls`}
        className={cn("block h-10 w-full rounded-md focus-visible:outline-none lg:h-7", hovered ? "bg-muted" : "active:bg-muted")}
        style={{ paddingLeft: PLOT_LEFT, paddingRight: PLOT_RIGHT }}
      >
        <span className="relative block h-full">
          <span
            className={cn("absolute bottom-3 truncate text-xs leading-4 lg:text-[11px] lg:leading-[14px]", lane.title.muted ? "text-muted-foreground" : "text-foreground/80", hovered && "text-foreground")}
            style={fromStart ? { left: at(start), maxWidth: at(24 - start) } : { right: `calc(${at(24 - end)} + 8px)`, maxWidth: `calc(${at(end)} - 8px)`, textAlign: "right" }}
          >
            {lane.title.text}
          </span>
          <span className="absolute bottom-1 h-1.5 min-w-1.5 rounded-full" style={{ left: at(start), width: at(end - start), background: harnessMeta(lane.harness).color }} />
          {lane.live ? (
            <span className="absolute bottom-[1px] -translate-x-1/2 rounded-full bg-card p-0.5" style={{ left: at(end) }}>
              <Pulse harness={lane.harness} fresh={lane.fresh} />
            </span>
          ) : null}
        </span>
      </button>
      {hovered ? <LaneTip lane={lane} below={tipBelow} /> : null}
    </li>
  )
}

/** One lane per session active today, from first to last activity, on the same 00 to 24 plot as the Today chart. */
export function SessionLanes({ rows, day, now, onOpen, axis }: { rows: SessionRow[]; day: string; now: number; onOpen: (id: string) => void; axis?: boolean }) {
  const [all, setAll] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)
  const lanes = toLanes(rows, day, now)
  const shown = pick(lanes, all)
  const nowAt = dayHours(day, now)
  return (
    <div className="grid gap-1">
      <div className="relative">
        <div aria-hidden className="pointer-events-none absolute inset-y-0" style={{ left: PLOT_LEFT, right: PLOT_RIGHT }}>
          {nowAt < 24 ? <span className="absolute inset-y-0 right-0 bg-muted/70" style={{ left: at(clip(nowAt)) }} /> : null}
          {GRID.map((h) => <span key={h} className="absolute inset-y-0 w-px bg-border/80" style={{ left: at(h) }} />)}
        </div>
        <ul aria-label={`Sessions active today, start to last activity. ${lanesNote(rows, now)}.`} className="relative grid">
          {shown.map((l, i) => (
            <LaneRow key={l.id} lane={l} tipBelow={i < shown.length - 3} hovered={hovered === l.id} onHover={setHovered} onOpen={onOpen} />
          ))}
        </ul>
        <NowLine at={nowAt} />
      </div>
      {axis ? (
        <div aria-hidden className="relative h-4 text-xs leading-4 text-muted-foreground tabular-nums" style={{ marginLeft: PLOT_LEFT, marginRight: PLOT_RIGHT }}>
          {GRID.filter((h) => h < 24).map((h) => <span key={h} className="absolute -translate-x-1/2" style={{ left: at(h) }}>{pad2(h)}</span>)}
        </div>
      ) : null}
      {lanes.length > CAP ? (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          aria-expanded={all}
          className="h-10 justify-self-start rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          style={{ marginLeft: PLOT_LEFT - 8 }}
        >
          {all ? `Show the busiest ${CAP}` : `Show all ${fmt(lanes.length)}`}
        </button>
      ) : null}
    </div>
  )
}
