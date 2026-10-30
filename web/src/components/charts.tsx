import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, LabelList, Rectangle, ReferenceArea, ReferenceLine, XAxis, YAxis } from "recharts"

import { useWidth } from "@/components/insights-layout"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import { compact, fmt, longDay } from "@/lib/format"
import { HARNESS_CHART_CONFIG, harnessMeta } from "@/lib/harness"

export type TipRow = { label: string; value: string; color?: string; strong?: boolean }

export function TipBox({ title, rows }: { title: string; rows: TipRow[] }) {
  return (
    <div className="grid min-w-40 gap-1.5 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-lg">
      <div className="font-medium text-foreground">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-2 text-muted-foreground">
            {r.color ? <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: r.color }} /> : null}
            {r.label}
          </span>
          <span className={r.strong ? "font-semibold text-foreground tabular-nums" : "font-medium text-foreground tabular-nums"}>{r.value}</span>
        </div>
      ))}
    </div>
  )
}

export type SparkPoint = { key: string; title: string; value: number }

/** A small area with no axes for one harness. The tooltip names the point and its value. */
export function Spark({ points, harness, unit, ariaLabel }: { points: SparkPoint[]; harness: string; unit: string; ariaLabel: string }) {
  const { color } = harnessMeta(harness)
  return (
    <div role="figure" aria-label={ariaLabel}>
      <ChartContainer config={HARNESS_CHART_CONFIG} className="aspect-auto h-10 w-full">
        <AreaChart data={points} margin={{ top: 6, right: 6, bottom: 2, left: 0 }} accessibilityLayer>
          <YAxis hide domain={[0, "dataMax"]} />
          <ChartTooltip
            cursor={{ stroke: "var(--border)" }}
            content={({ active, payload }) => {
              const p = active ? (payload?.[0]?.payload as SparkPoint | undefined) : undefined
              return p ? <TipBox title={p.title} rows={[{ label: unit, value: fmt(p.value), color, strong: true }]} /> : null
            }}
          />
          <Area
            dataKey="value"
            type="monotone"
            stroke={color}
            strokeWidth={2}
            fill={color}
            fillOpacity={0.1}
            dot={(p: { cx?: number; cy?: number; index?: number }) =>
              p.index === points.length - 1 ? <circle key="end" cx={p.cx} cy={p.cy} r={4} fill={color} stroke="var(--card)" strokeWidth={2} /> : <g key={p.index} />
            }
            activeDot={{ r: 4, fill: color, stroke: "var(--card)", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ChartContainer>
    </div>
  )
}

type DayPoint = { day: string; value: number | null; today: boolean }

/** One bar per day with today in ink and earlier days in gray. Days before the first record have no bar. */
export function DaySpark({
  days, value, today, unit, fmt: fmtN, ariaLabel,
}: { days: string[]; value: (day: string) => number | null; today: string; unit: string; fmt: (n: number) => string; ariaLabel: string }) {
  const points: DayPoint[] = days.map((d) => ({ day: d, value: value(d), today: d === today }))
  return (
    <div role="figure" aria-label={ariaLabel} className="max-w-44 border-b border-border">
      <ChartContainer config={HARNESS_CHART_CONFIG} className="aspect-auto h-9 w-full">
        <BarChart data={points} margin={{ top: 2, right: 0, bottom: 0, left: 0 }} barCategoryGap={2} accessibilityLayer>
          <YAxis hide domain={[0, "dataMax"]} />
          <XAxis dataKey="day" hide />
          <ChartTooltip
            cursor={false}
            content={({ active, payload }) => {
              const p = active ? (payload?.[0]?.payload as DayPoint | undefined) : undefined
              return p && p.value !== null ? <TipBox title={p.today ? "Today so far" : longDay(p.day)} rows={[{ label: unit, value: fmtN(p.value), strong: true }]} /> : null
            }}
          />
          <Bar dataKey="value" radius={[2, 2, 0, 0]} maxBarSize={12} minPointSize={1} isAnimationActive={false}>
            {points.map((p) => <Cell key={p.day} fill={p.today ? "var(--spark-today)" : "var(--spark-past)"} />)}
          </Bar>
        </BarChart>
      </ChartContainer>
    </div>
  )
}

type Row = Record<string, number | string> & { __key: string; __tick: string; __title: string; __total: number; __label: string }

const TOP_RADIUS: [number, number, number, number] = [4, 4, 0, 0]
const SEGMENT_GAP = 2

/** Columns stacked by harness. One tooltip per column lists every series and the total. */
export function StackedColumns<C extends string | number>({
  categories, series, value, tick, title, ariaLabel, height = 240, labelTotals = true, tickWidth = 40, reference, shade, barSize = 24, max, xAxis = true, yTicks,
}: {
  categories: C[]
  series: string[]
  value: (category: C, harness: string) => number
  tick: (category: C) => string
  title: (category: C) => string
  ariaLabel: string
  /** Pixels, or any CSS height. */
  height?: number | string
  /** "peak" labels only the tallest column. */
  labelTotals?: boolean | "peak"
  tickWidth?: number
  /** A labeled horizontal line, e.g. the average. */
  reference?: { value: number; label: string }
  /** Categories that get a soft background band, e.g. weekends. */
  shade?: (category: C) => boolean
  barSize?: number
  /** Fixes the top of the value axis, so several charts share one scale. */
  max?: number
  xAxis?: boolean
  yTicks?: number[]
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const rows: Row[] = categories.map((c) => {
    const row: Row = { __key: String(c), __tick: tick(c), __title: title(c), __total: 0, __label: "" }
    for (const h of series) {
      const v = value(c, h)
      row[h] = v
      row.__total += v
    }
    return row
  })
  const peak = rows.reduce<Row | null>((best, r) => (r.__total > (best?.__total ?? 0) ? r : best), null)
  for (const r of rows) r.__label = r.__total > 0 && (labelTotals === true || r === peak) ? compact(r.__total) : ""
  const refGutter = reference ? reference.label.length * 6 + 12 : 0
  const plotWidth = Math.max(0, width - 48 - refGutter)
  const band = plotWidth / Math.max(1, rows.length)
  const showLabels = labelTotals === "peak" ? peak !== null : labelTotals && band >= 44
  const tickStep = band > 0 ? Math.max(1, Math.ceil(tickWidth / band)) : 1
  const topOf = (row: Row) => series.findLast((h) => Number(row[h]) > 0)
  const bottomOf = (row: Row) => series.find((h) => Number(row[h]) > 0)

  return (
    <div ref={ref} role="figure" aria-label={ariaLabel}>
      <ChartContainer config={HARNESS_CHART_CONFIG} className="aspect-auto w-full" style={{ height }}>
        <BarChart data={rows} margin={{ top: showLabels ? 20 : 8, right: 4 + refGutter, bottom: 0, left: 0 }} accessibilityLayer>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          {shade
            ? categories.filter(shade).map((c) => (
                <ReferenceArea key={String(c)} x1={tick(c)} x2={tick(c)} fill="var(--muted)" fillOpacity={1} radius={4} zIndex={-150} ifOverflow="hidden" />
              ))
            : null}
          {reference ? (
            <ReferenceLine
              y={reference.value}
              stroke="var(--muted-foreground)"
              strokeOpacity={0.55}
              label={{ value: reference.label, position: "right", offset: 6, className: "fill-muted-foreground text-[11px] tabular-nums" }}
            />
          ) : null}
          <XAxis dataKey="__tick" hide={!xAxis} tickLine={false} axisLine={{ stroke: "var(--border)" }} tickMargin={8} interval={tickStep - 1} className="tabular-nums" />
          <YAxis tickLine={false} axisLine={false} width={44} tickMargin={4} domain={[0, max ?? "auto"]} ticks={yTicks} tickFormatter={(v: number) => compact(v)} allowDecimals={false} className="tabular-nums" />
          <ChartTooltip
            cursor={{ fill: "var(--muted)", radius: 4 }}
            content={({ active, payload }) => {
              const row = active ? (payload?.[0]?.payload as Row | undefined) : undefined
              if (!row) return null
              const tipRows: TipRow[] = series.map((h) => ({ label: harnessMeta(h).label, color: harnessMeta(h).color, value: fmt(Number(row[h])) }))
              if (series.length > 1) tipRows.push({ label: "Total", value: fmt(row.__total), strong: true })
              return <TipBox title={row.__title} rows={tipRows} />
            }}
          />
          {series.map((h, i) => (
            <Bar
              key={h}
              dataKey={h}
              name={harnessMeta(h).label}
              stackId="harness"
              fill={harnessMeta(h).color}
              maxBarSize={barSize}
              isAnimationActive={false}
              shape={(props: { x?: number; y?: number; width?: number; height?: number; payload?: Row }) => {
                const { x = 0, y = 0, width: w = 0, height: hgt = 0, payload } = props
                if (!payload || hgt <= 0) return <g />
                const gap = bottomOf(payload) === h ? 0 : SEGMENT_GAP
                return (
                  <Rectangle
                    x={x}
                    y={y}
                    width={w}
                    height={Math.max(1, hgt - gap)}
                    fill={harnessMeta(h).color}
                    radius={topOf(payload) === h ? TOP_RADIUS : 0}
                  />
                )
              }}
            >
              {showLabels && i === series.length - 1 ? (
                <LabelList dataKey="__label" position="top" offset={6} className="fill-foreground text-[11px] font-medium tabular-nums" />
              ) : null}
            </Bar>
          ))}
        </BarChart>
      </ChartContainer>
    </div>
  )
}
