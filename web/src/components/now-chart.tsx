import { useLayoutEffect, useRef, useState } from "react"
import { Bar, CartesianGrid, ComposedChart, Line, Rectangle, ReferenceArea, XAxis, YAxis } from "recharts"
import { cn } from "cn"

import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import { compact, fmt, hourLabel, pad2 } from "@/lib/format"
import { HARNESS_CHART_CONFIG, harnessMeta } from "@/lib/harness"

export type HourPoint = {
  hour: number
  values: Record<string, number>
  total: number
  /** Null until yesterday's hours have loaded. */
  yesterday: number | null
}

/** The plot area's insets inside the chart box: the y axis on the left, the right margin. The session lanes reuse them to share the x axis. */
export const PLOT_LEFT = 44
export const PLOT_RIGHT = 4
const X_AXIS_H = 30

const TOP_RADIUS: [number, number, number, number] = [4, 4, 0, 0]
const SEGMENT_GAP = 2
const YESTERDAY = "var(--muted-foreground)"

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

export function YesterdayKey() {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <span aria-hidden className="h-[1.5px] w-3.5" style={{ background: YESTERDAY }} />
      Yesterday
    </span>
  )
}

/** A vertical marker at `at` hours on a 00 to 24 plot spanning the parent, inset like the chart's plot area. */
export function NowLine({ at, label, bottom = 0 }: { at: number; label?: boolean; bottom?: number }) {
  if (at < 0 || at >= 24) return null
  return (
    <div aria-hidden className="pointer-events-none absolute top-0" style={{ left: PLOT_LEFT, right: PLOT_RIGHT, bottom }}>
      <div className={cn("absolute bottom-0 w-px -translate-x-1/2 bg-foreground/75", label ? "top-4" : "top-0")} style={{ left: `${(at / 24) * 100}%` }}>
        {label ? <span className="absolute -top-4 left-1/2 -translate-x-1/2 text-[11px] leading-4 font-semibold text-foreground">Now</span> : null}
      </div>
    </div>
  )
}

/** Today's hours stacked by agent, yesterday's hourly total as a line, the hours still to come shaded, and a line at the current minute. */
export function DayChart({
  points, series, now, ariaLabel, height,
}: { points: HourPoint[]; series: string[]; now: number; ariaLabel: string; height: string }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const band = Math.max(0, width - PLOT_LEFT - PLOT_RIGHT) / points.length
  const tickStep = band > 0 ? Math.max(1, Math.ceil(28 / band)) : 1
  const data = points.map((p) => ({ ...p, ...p.values }))
  const topOf = (p: HourPoint) => series.findLast((h) => (p.values[h] ?? 0) > 0)
  const bottomOf = (p: HourPoint) => series.find((h) => (p.values[h] ?? 0) > 0)
  const hour = Math.floor(now)
  const inDay = now >= 0 && now < 24

  return (
    <div ref={ref} role="figure" aria-label={ariaLabel} className="relative">
      <ChartContainer config={HARNESS_CHART_CONFIG} className="aspect-auto w-full" style={{ height }}>
        <ComposedChart data={data} margin={{ top: inDay ? 18 : 8, right: PLOT_RIGHT, bottom: 0, left: 0 }} barCategoryGap="18%" accessibilityLayer>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          {inDay && hour < 23 ? <ReferenceArea x1={hour + 1} x2={23} fill="var(--muted)" fillOpacity={0.7} ifOverflow="extendDomain" /> : null}
          <XAxis
            dataKey="hour"
            type="category"
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
            tickMargin={8}
            height={X_AXIS_H}
            interval={tickStep - 1}
            tickFormatter={pad2}
            className="tabular-nums"
          />
          <YAxis tickLine={false} axisLine={false} width={PLOT_LEFT} tickMargin={4} tickFormatter={(v: number) => compact(v)} allowDecimals={false} className="tabular-nums" />
          <ChartTooltip
            cursor={{ fill: "var(--muted)", radius: 4 }}
            content={({ active, payload }) => {
              const p = active ? (payload?.[0]?.payload as HourPoint | undefined) : undefined
              if (!p) return null
              return (
                <div className="grid min-w-40 gap-1.5 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-lg">
                  <div className="font-medium text-foreground">
                    {hourLabel(p.hour)}
                    {p.hour === hour ? <span className="font-normal text-muted-foreground"> · so far</span> : null}
                  </div>
                  {series.map((h) => (
                    <Tip key={h} label={harnessMeta(h).label} color={harnessMeta(h).color} value={fmt(p.values[h] ?? 0)} />
                  ))}
                  {series.length > 1 ? <Tip label="Total" value={fmt(p.total)} strong /> : null}
                  {p.yesterday !== null ? <Tip label="Yesterday" color={YESTERDAY} value={fmt(p.yesterday)} /> : null}
                </div>
              )
            }}
          />
          {series.map((h) => (
            <Bar
              key={h}
              dataKey={h}
              name={harnessMeta(h).label}
              stackId="harness"
              fill={harnessMeta(h).color}
              maxBarSize={24}
              isAnimationActive={false}
              shape={(props: { x?: number; y?: number; width?: number; height?: number; payload?: HourPoint }) => {
                const { x = 0, y = 0, width: w = 0, height: hgt = 0, payload } = props
                if (!payload || hgt <= 0) return <g />
                return (
                  <Rectangle
                    x={x}
                    y={y}
                    width={w}
                    height={Math.max(1, hgt - (bottomOf(payload) === h ? 0 : SEGMENT_GAP))}
                    fill={harnessMeta(h).color}
                    radius={topOf(payload) === h ? TOP_RADIUS : 0}
                  />
                )
              }}
            />
          ))}
          <Line
            dataKey="yesterday"
            name="Yesterday"
            type="linear"
            stroke={YESTERDAY}
            strokeWidth={1.5}
            dot={false}
            activeDot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ChartContainer>
      {inDay ? <NowLine at={now} label bottom={X_AXIS_H} /> : null}
    </div>
  )
}

function Tip({ label, value, color, strong }: { label: string; value: string; color?: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex items-center gap-2 text-muted-foreground">
        {color ? <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: color }} /> : null}
        {label}
      </span>
      <span className={strong ? "font-semibold text-foreground tabular-nums" : "font-medium text-foreground tabular-nums"}>{value}</span>
    </div>
  )
}
