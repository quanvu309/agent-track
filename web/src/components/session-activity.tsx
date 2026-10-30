import { useState } from "react"

import { Tip, TimeTicks } from "@/components/session-viz"
import { dur, fmt } from "@/lib/format"
import { harnessMeta } from "@/lib/harness"
import { useWidth } from "@/lib/session-use-width"
import { at, bucketEvents, timeTicks } from "@/lib/session-layout"
import type { EventRow } from "@/lib/types"

const PLOT_H = 112
const RUG_H = 16
const GUTTER = 28
const MAX_BAR = 24
const RESPONSE_ALPHA = 0.38

function niceMax(n: number) {
  if (n <= 1) return 1
  const p = 10 ** Math.floor(Math.log10(n))
  return ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((m) => m >= n) ?? 10 * p)
}

/** A column whose top corners are rounded and whose base sits square on the baseline. */
function column(x: number, y: number, w: number, h: number, r: number) {
  const k = Math.min(r, w / 2, h)
  return `M${x},${y + h}V${y + k}Q${x},${y} ${x + k},${y}H${x + w - k}Q${x + w},${y} ${x + w},${y + k}V${y + h}Z`
}

const stepText = (ms: number) => (ms < 60_000 ? `${ms / 1000} s` : ms < 3_600_000 ? `${ms / 60_000} min` : ms < 86_400_000 ? `${ms / 3_600_000} h` : `${ms / 86_400_000} d`)
const clock = (t: number, seconds: boolean) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: false })

/** Events per time bucket: tool calls and responses stacked, prompts as dots above. Built from the events the API returns. */
export function ActivityChart({ events, harness, total, sessionSeconds }: { events: EventRow[]; harness: string; total: number; sessionSeconds: number }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const color = harnessMeta(harness).color
  const target = width && width < 520 ? 24 : 40
  const b = bucketEvents(events, target)
  if (!b) return <p className="text-xs text-muted-foreground">No events recorded</p>
  const plotW = Math.max(0, width - GUTTER)
  const x = (t: number) => GUTTER + at(b.domain, t) * plotW
  const slot = plotW / b.buckets.length
  const barW = Math.max(2, Math.min(MAX_BAR, slot - 2))
  const yMax = niceMax(Math.max(...b.buckets.map((k) => k.tool_call + k.response)))
  const y = (n: number) => RUG_H + PLOT_H - (n / yMax) * PLOT_H
  const prompts = events.filter((e) => e.kind === "prompt").map((e) => Date.parse(e.ts))
  const ticks = timeTicks(b.domain, width < 520 ? 4 : 6)
  const truncated = total > events.length
  const windowS = (Date.parse(events[events.length - 1].ts) - Date.parse(events[0].ts)) / 1000
  const hovered = hover === null ? null : b.buckets[hover]
  const seconds = b.step < 60_000
  const swatch = (fill: string, opacity = 1) => <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: fill, opacity }} />
  return (
    <div className="grid min-w-0 gap-2">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
        <li className="inline-flex items-center gap-1.5">{swatch(color)}Tool calls</li>
        <li className="inline-flex items-center gap-1.5">{swatch(color, RESPONSE_ALPHA)}Responses</li>
        <li className="inline-flex items-center gap-1.5"><span aria-hidden className="size-2 rounded-full bg-foreground" />Prompts</li>
      </ul>
      <div ref={ref} className="relative w-full" onPointerLeave={() => setHover(null)}>
        {width ? (
          <svg
            width={width}
            height={RUG_H + PLOT_H + 1}
            role="img"
            aria-label={`Activity in ${stepText(b.step)} buckets: ${fmt(events.filter((e) => e.kind === "tool_call").length)} tool calls, ${fmt(events.filter((e) => e.kind === "response").length)} responses and ${fmt(prompts.length)} prompts`}
            className="block overflow-visible"
          >
            <line x1={GUTTER} x2={width} y1={y(yMax)} y2={y(yMax)} stroke="var(--border)" />
            <line x1={GUTTER} x2={width} y1={y(yMax / 2)} y2={y(yMax / 2)} stroke="var(--border)" strokeDasharray="2 4" />
            <text x={GUTTER - 6} y={y(yMax) + 4} textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">{fmt(yMax)}</text>
            <text x={GUTTER - 6} y={y(0)} textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">0</text>
            {hovered ? <rect x={GUTTER + hover! * slot} y={RUG_H - 2} width={slot} height={PLOT_H + 2} rx={4} fill="var(--raised)" /> : null}
            {b.buckets.map((k, i) => {
              const cx = GUTTER + (i + 0.5) * slot
              const left = cx - barW / 2
              const toolTop = y(k.tool_call)
              const respTop = y(k.tool_call + k.response)
              const gap = k.tool_call && k.response ? 2 : 0
              return (
                <g key={k.start}>
                  {k.tool_call ? <path d={column(left, toolTop, barW, y(0) - toolTop, k.response ? 0 : 3)} fill={color} /> : null}
                  {k.response ? <path d={column(left, respTop, barW, Math.max(1, toolTop - respTop - gap), 3)} fill={color} fillOpacity={RESPONSE_ALPHA} /> : null}
                </g>
              )
            })}
            <line x1={GUTTER} x2={width} y1={y(0) + 0.5} y2={y(0) + 0.5} stroke="var(--border)" />
            {prompts.map((t, i) => (
              <circle key={i} cx={x(t)} cy={RUG_H / 2 - 1} r={4} fill="var(--foreground)" stroke="var(--card)" strokeWidth={2} />
            ))}
            {b.buckets.map((k, i) => (
              <rect
                key={k.start}
                x={GUTTER + i * slot}
                y={0}
                width={slot}
                height={RUG_H + PLOT_H}
                fill="transparent"
                onPointerEnter={() => setHover(i)}
                onPointerDown={() => setHover(i)}
              />
            ))}
          </svg>
        ) : (
          <div style={{ height: RUG_H + PLOT_H + 1 }} />
        )}
        {width ? <TimeTicks ticks={ticks} pos={(t) => (GUTTER + at(b.domain, t) * plotW) / width} className="mt-1" /> : null}
        {hovered && hover !== null ? (
          <Tip
            x={GUTTER + (hover + 0.5) * slot}
            y={y(hovered.tool_call + hovered.response)}
            width={width}
            title={`${clock(hovered.start, seconds)} to ${clock(hovered.end, seconds)}`}
            lines={[
              { label: "Tool calls", value: fmt(hovered.tool_call), swatch: color, strong: true },
              { label: "Responses", value: fmt(hovered.response), swatch: `color-mix(in oklab, ${color} ${RESPONSE_ALPHA * 100}%, var(--card))` },
              { label: "Prompts", value: fmt(hovered.prompt), swatch: "var(--foreground)" },
            ]}
          />
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {truncated
          ? `Latest ${fmt(events.length)} of ${fmt(total)} events, covering the last ${dur(windowS)} of ${dur(sessionSeconds)}. Each bar is ${stepText(b.step)}.`
          : `All ${fmt(events.length)} events. Each bar is ${stepText(b.step)}.`}
      </p>
    </div>
  )
}
