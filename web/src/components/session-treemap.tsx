import { type PointerEvent, useState } from "react"

import { HarnessDot } from "@/components/kit"
import { Tip } from "@/components/session-viz"
import { compact, fmt, pct } from "@/lib/format"
import { harnessMeta } from "@/lib/harness"
import { useWidth } from "@/lib/session-use-width"
import { since } from "@/lib/session-format"
import { squarify } from "@/lib/session-layout"
import type { ProjectRow } from "@/lib/types"

const MAX_TILES = 20
const MIN_SHARE = 0.005
const GAP = 2

type Tile = { kind: "project"; row: ProjectRow } | { kind: "rest"; rows: ProjectRow[]; calls: number }

/** Projects as areas sized by tool calls. Small projects fold into one tile; the list below has them all. */
export function ProjectsTreemap({ rows, name, onPick, now }: { rows: ProjectRow[]; name: (p: string | null) => string; onPick: (project: string) => void; now: number }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null)
  const height = width < 640 ? 220 : 280
  const total = rows.reduce((a, r) => a + r.tool_calls, 0)
  const ranked = rows.filter((r) => r.tool_calls > 0).sort((a, b) => b.tool_calls - a.tool_calls)
  const head = ranked.filter((r, i) => i < MAX_TILES && r.tool_calls / total >= MIN_SHARE)
  const rest = ranked.slice(head.length)
  const restCalls = rest.reduce((a, r) => a + r.tool_calls, 0)
  const items: { value: number; item: Tile }[] = [
    ...head.map((row) => ({ value: row.tool_calls, item: { kind: "project", row } as Tile })),
    ...(rest.length ? [{ value: restCalls, item: { kind: "rest", rows: rest, calls: restCalls } as Tile }] : []),
  ]
  const tiles = width ? squarify(items, { x: 0, y: 0, w: width, h: height }) : []
  const hovered = hover === null ? null : tiles[hover.i]
  const track = (i: number) => (e: PointerEvent) => {
    const box = e.currentTarget.parentElement!.getBoundingClientRect()
    setHover({ i, x: e.clientX - box.left, y: e.clientY - box.top })
  }
  return (
    <div
      ref={ref}
      role="group"
      aria-label={`Projects sized by tool calls. ${head.length} largest shown${rest.length ? `, ${rest.length} more grouped` : ""}`}
      className="relative w-full"
      style={{ height }}
      onPointerLeave={() => setHover(null)}
    >
      {tiles.map((t, i) => {
        const w = t.w - GAP
        const h = t.h - GAP
        const style = { left: t.x + GAP / 2, top: t.y + GAP / 2, width: Math.max(0, w), height: Math.max(0, h) }
        const showDots = w >= 30 && h >= 22
        const showName = w >= 60 && h >= 40
        const showFigure = w >= 60 && h >= 58
        const big = w >= 150 && h >= 110
        if (t.item.kind === "rest") {
          return (
            <div
              key="rest"
              className="absolute grid content-start gap-0.5 overflow-hidden rounded-md border border-border bg-muted p-2 text-xs text-muted-foreground"
              style={style}
              onPointerMove={track(i)}
            >
              {showName ? <span className="truncate font-medium">{fmt(t.item.rows.length)} more</span> : null}
              {showFigure ? <span className="tabular-nums">{pct(t.item.calls, total)}</span> : null}
            </div>
          )
        }
        const r = t.item.row
        return (
          <button
            key={r.project}
            type="button"
            onClick={() => onPick(r.project)}
            onPointerMove={track(i)}
            onFocus={() => setHover({ i, x: t.x + t.w / 2, y: t.y + t.h / 2 })}
            onBlur={() => setHover(null)}
            aria-label={`${name(r.project)}, ${pct(r.tool_calls, total)} of tool calls. Filter sessions to this project`}
            className="absolute grid content-start justify-items-start gap-1 overflow-hidden rounded-md border border-border bg-raised p-2 text-left transition-colors duration-150 ease-out hover:bg-secondary active:bg-muted"
            style={style}
          >
            {showDots ? (
              <span className="flex w-full items-center gap-1">
                {r.harnesses.map((id) => <HarnessDot key={id} id={id} className="size-2" />)}
              </span>
            ) : null}
            {showName ? <span className="max-w-full truncate text-[13px] leading-4 font-medium text-foreground">{name(r.project)}</span> : null}
            {big ? (
              <span className="grid gap-0.5">
                <span className="text-xl leading-7 font-semibold tracking-[-0.01em] tabular-nums text-foreground">{pct(r.tool_calls, total)}</span>
                <span className="text-xs text-muted-foreground">{compact(r.tool_calls)} tool calls</span>
              </span>
            ) : showFigure ? (
              <span className="max-w-full truncate text-xs leading-4 text-muted-foreground tabular-nums">
                <span className="font-medium text-foreground">{pct(r.tool_calls, total)}</span> · {compact(r.tool_calls)}
              </span>
            ) : null}
          </button>
        )
      })}
      {hover && hovered ? (
        <Tip
          x={hover.x}
          y={hover.y < height / 2 ? hover.y + 8 : hover.y - 8}
          below={hover.y < height / 2}
          width={width}
          title={hovered.item.kind === "project" ? name(hovered.item.row.project) : `${fmt(hovered.item.rows.length)} smaller projects`}
          lines={
            hovered.item.kind === "project"
              ? [
                  { label: "Tool calls", value: fmt(hovered.item.row.tool_calls), strong: true },
                  { label: "Share", value: pct(hovered.item.row.tool_calls, total) },
                  { label: "Sessions", value: fmt(hovered.item.row.sessions) },
                  {
                    label: "Agents",
                    value: (
                      <span className="flex gap-1" aria-label={hovered.item.row.harnesses.map((h) => harnessMeta(h).label).join(", ")}>
                        {hovered.item.row.harnesses.map((id) => <HarnessDot key={id} id={id} className="size-2" />)}
                      </span>
                    ),
                  },
                  { label: "Last active", value: since(hovered.item.row.last_active, now) },
                ]
              : [
                  { label: "Tool calls", value: fmt(hovered.item.calls), strong: true },
                  { label: "Share", value: pct(hovered.item.calls, total) },
                ]
          }
        />
      ) : null}
    </div>
  )
}
