import { useRef, useState, type KeyboardEvent } from "react"

import { StackedColumns } from "@/components/charts"
import { DataTable } from "@/components/data-table"
import { HarnessDot, HarnessLegend, Panel, Segmented } from "@/components/kit"
import { status } from "@/lib/panel-status"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { Loaded } from "@/lib/api"
import { compact, dayLabel, daySpan, fmt, longDay, pad2 } from "@/lib/format"
import { harnessMeta } from "@/lib/harness"
import type { DailyRow, HeatCell } from "@/lib/types"

const DAILY_METRICS = [
  ["sessions", "Sessions"],
  ["input_tokens", "Input"],
  ["output_tokens", "Output"],
  ["prompts", "Prompts"],
  ["tool_calls", "Tool calls"],
] as const
type DailyMetric = (typeof DAILY_METRICS)[number][0]
const LAYOUTS = [
  ["stacked", "Stacked"],
  ["split", "By agent"],
] as const
type Layout = (typeof LAYOUTS)[number][0]

const isWeekend = (day: string) => [0, 6].includes(new Date(day + "T00:00:00Z").getUTCDay())
const niceCeil = (n: number) => {
  if (n <= 0) return 1
  const step = 10 ** Math.floor(Math.log10(n))
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * step).find((v) => v >= n)!
}
const avgText = (n: number) => (n >= 1000 ? compact(n) : String(Math.round(n * 10) / 10))

export function DailyCard({ daily, series }: { daily: Loaded<DailyRow[]>; series: string[] }) {
  const [metric, setMetric] = useState<DailyMetric>("sessions")
  const [layout, setLayout] = useState<Layout>("stacked")
  const metricLabel = DAILY_METRICS.find(([k]) => k === metric)![1]
  const rows = daily.data?.filter((r) => series.includes(r.harness)) ?? []
  const byKey = new Map(rows.map((r) => [`${r.day}|${r.harness}`, r]))
  const value = (day: string, h: string) => byKey.get(`${day}|${h}`)?.[metric] ?? 0
  const days = daySpan(rows)
  const dayTotal = (day: string) => series.reduce((a, h) => a + value(day, h), 0)
  const avg = days.length ? days.reduce((a, d) => a + dayTotal(d), 0) / days.length : 0
  const weekend = days.some(isWeekend)
  const split = layout === "split" && series.length > 1
  const peak = niceCeil(Math.max(0, ...days.flatMap((d) => series.map((h) => value(d, h)))))
  return (
    <Panel
      title={`${metricLabel} per day`}
      description={metric === "sessions" ? "By start day. Ignores the date range." : "Ignores the date range."}
      controls={
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <Segmented label="Daily metric" fill className="sm:w-auto" options={DAILY_METRICS} value={metric} onChange={setMetric} />
          {series.length > 1 ? <Segmented label="Layout" fill className="sm:w-auto" options={LAYOUTS} value={layout} onChange={setLayout} /> : null}
        </div>
      }
      legend={
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {split ? null : <HarnessLegend ids={series} />}
          {weekend ? (
            <span className="inline-flex items-center gap-2">
              <span aria-hidden className="h-3 w-2.5 rounded-[3px] bg-muted ring-1 ring-border" />
              Weekend
            </span>
          ) : null}
        </div>
      }
      status={status(daily.data, () => rows.length === 0)}
      stale={daily.loading && daily.data !== undefined}
      chart={() =>
        split ? (
          <div className="grid gap-3" role="group" aria-label={`${metricLabel} per day, one chart per agent on a shared scale`}>
            {series.map((h, i) => {
              const total = days.reduce((a, d) => a + value(d, h), 0)
              const agentAvg = days.length ? total / days.length : 0
              return (
                <section key={h} aria-label={harnessMeta(h).label} className="grid gap-1">
                  <h3 className="flex items-center gap-2 text-xs">
                    <HarnessDot id={h} />
                    <span className="font-medium">{harnessMeta(h).label}</span>
                    <span className="text-muted-foreground tabular-nums" title={fmt(total)}>{compact(total)} total</span>
                  </h3>
                  <StackedColumns
                    categories={days}
                    series={[h]}
                    value={value}
                    tick={dayLabel}
                    title={longDay}
                    height={i === series.length - 1 ? 104 : 80}
                    barSize={20}
                    labelTotals="peak"
                    max={peak}
                    yTicks={[0, peak]}
                    xAxis={i === series.length - 1}
                    reference={days.length > 1 ? { value: agentAvg, label: `avg ${avgText(agentAvg)}` } : undefined}
                    shade={isWeekend}
                    ariaLabel={`${harnessMeta(h).label}, ${metricLabel.toLowerCase()} per day. Average ${avgText(agentAvg)} a day.`}
                  />
                </section>
              )
            })}
          </div>
        ) : (
          <StackedColumns
            categories={days}
            series={series}
            value={value}
            tick={dayLabel}
            title={longDay}
            height={260}
            barSize={20}
            labelTotals="peak"
            reference={days.length > 1 ? { value: avg, label: `avg ${avgText(avg)}` } : undefined}
            shade={isWeekend}
            ariaLabel={`${metricLabel} per day, stacked by agent. Average ${avgText(avg)} a day.`}
          />
        )
      }
      table={() => (
        <DataTable
          label={`${metricLabel} per day`}
          rows={[...days].reverse()}
          rowKey={(d) => d}
          maxHeight={320}
          columns={[
            { key: "day", label: "Day", cell: (d: string) => d },
            ...series.map((h) => ({ key: h, label: harnessMeta(h).label, num: true, cell: (d: string) => fmt(value(d, h)) })),
            { key: "total", label: "Total", num: true, cell: (d: string) => fmt(dayTotal(d)) },
          ]}
        />
      )}
    />
  )
}

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const HOURS = Array.from({ length: 24 }, (_, i) => i)
// Square root keeps quiet hours visible next to one very busy slot.
const heat = (f: number) => `color-mix(in oklch, var(--heat-hi) ${Math.round(Math.sqrt(f) * 100)}%, var(--heat-lo))`

function HeatGrid({ cells }: { cells: HeatCell[] }) {
  const by = new Map(cells.map((c) => [c.weekday * 24 + c.hour, c]))
  const max = Math.max(1, ...cells.map((c) => c.events))
  const dayTotals = DAY_NAMES.map((_, wd) => HOURS.reduce((a, hr) => a + (by.get(wd * 24 + hr)?.events ?? 0), 0))
  const hourTotals = HOURS.map((hr) => DAY_ORDER.reduce((a, wd) => a + (by.get(wd * 24 + hr)?.events ?? 0), 0))
  const maxHour = Math.max(1, ...hourTotals)
  const peakHour = hourTotals.indexOf(Math.max(...hourTotals))
  const peakDay = dayTotals.indexOf(Math.max(...dayTotals))
  const busiest = cells.reduce<HeatCell | null>(
    (best, c) => (!best || c.events > best.events || (c.events === best.events && DAY_ORDER.indexOf(c.weekday) * 24 + c.hour < DAY_ORDER.indexOf(best.weekday) * 24 + best.hour) ? c : best),
    null,
  )
  const [focus, setFocus] = useState(0)
  const [readout, setReadout] = useState<string | null>(null)
  const refs = useRef<(HTMLDivElement | null)[]>([])
  const cellText = (i: number) => {
    const wd = DAY_ORDER[Math.floor(i / 24)]
    const cell = by.get(wd * 24 + (i % 24))
    return `${DAY_NAMES[wd]} ${pad2(i % 24)}:00 · ${fmt(cell?.events ?? 0)} events · ${fmt(cell?.prompts ?? 0)} prompts`
  }
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 24, ArrowUp: -24 }[e.key]
    const next = step === undefined ? -1 : i + step
    if (next < 0 || next >= 7 * 24) return
    e.preventDefault()
    setFocus(next)
    refs.current[next]?.focus()
  }
  return (
    <div className="flex flex-1 flex-col gap-3">
      {busiest && busiest.events > 0 ? (
        <p className="text-sm text-foreground tabular-nums">
          Busiest slot is {DAY_NAMES[busiest.weekday]} {pad2(busiest.hour)}:00, with {fmt(busiest.events)} events
        </p>
      ) : null}
      <div
        role="grid"
        aria-label="Events by weekday and hour, server local time"
        className="grid flex-1 grid-cols-[2rem_repeat(24,minmax(0,1fr))] grid-rows-[auto_repeat(7,minmax(0.875rem,1fr))_auto] gap-[2px] sm:grid-cols-[2.25rem_repeat(24,minmax(0,1fr))_3rem] sm:grid-rows-[auto_repeat(7,minmax(1.25rem,1fr))_auto] sm:gap-[3px]"
      >
        <div aria-hidden className="contents">
          <div className="flex items-end pb-0.5 text-[11px] text-muted-foreground">All</div>
          {HOURS.map((hr) => (
            <div
              key={hr}
              className="flex h-7 items-end sm:h-8"
              onPointerEnter={() => setReadout(`${pad2(hr)}:00 on all days · ${fmt(hourTotals[hr])} events`)}
            >
              <div
                className="w-full rounded-t-[2px]"
                style={{
                  height: hourTotals[hr] ? `${Math.max(6, (hourTotals[hr] / maxHour) * 100)}%` : 0,
                  background: hr === peakHour ? "var(--spark-today)" : "var(--spark-past)",
                }}
              />
            </div>
          ))}
          <div className="hidden items-end justify-end pb-0.5 text-[11px] text-muted-foreground sm:flex">Total</div>
        </div>
        {DAY_ORDER.map((wd, row) => (
          <div role="row" key={wd} className="contents">
            <div role="rowheader" aria-label={`${DAY_NAMES[wd]}, ${fmt(dayTotals[wd])} events`} className="flex items-center text-[11px] text-muted-foreground">
              {DAY_NAMES[wd]}
            </div>
            {HOURS.map((hr) => {
              const i = row * 24 + hr
              const cell = by.get(wd * 24 + hr)
              const events = cell?.events ?? 0
              const prompts = cell?.prompts ?? 0
              const slot = `${DAY_NAMES[wd]} ${pad2(hr)}:00`
              return (
                <Tooltip key={hr}>
                  <TooltipTrigger asChild>
                    <div
                      ref={(n) => { refs.current[i] = n }}
                      role="gridcell"
                      tabIndex={i === focus ? 0 : -1}
                      aria-label={`${slot}: ${fmt(events)} events, ${fmt(prompts)} prompts`}
                      onKeyDown={(e) => onKeyDown(e, i)}
                      onFocus={() => { setFocus(i); setReadout(cellText(i)) }}
                      onPointerEnter={() => setReadout(cellText(i))}
                      onClick={() => setReadout(cellText(i))}
                      className="rounded-[3px] outline-none hover:ring-2 hover:ring-foreground/40 focus-visible:ring-2 focus-visible:ring-ring"
                      style={{ background: events ? heat(events / max) : "var(--heat-0)" }}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="tabular-nums">
                    <div className="font-medium">{slot}</div>
                    <div>{fmt(events)} events · {fmt(prompts)} prompts</div>
                  </TooltipContent>
                </Tooltip>
              )
            })}
            <div
              aria-hidden
              className={`hidden items-center justify-end text-[11px] tabular-nums sm:flex ${wd === peakDay ? "font-medium text-foreground" : "text-muted-foreground"}`}
              title={`${fmt(dayTotals[wd])} events`}
            >
              {compact(dayTotals[wd])}
            </div>
          </div>
        ))}
        <div aria-hidden />
        {HOURS.map((hr) => (
          <div key={hr} aria-hidden className="pt-1 text-center text-[11px] text-muted-foreground tabular-nums">
            <span className={hr % 6 === 0 ? "" : hr % 3 === 0 ? "hidden sm:inline" : "hidden"}>{pad2(hr)}</span>
          </div>
        ))}
        <div aria-hidden className="hidden sm:block" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <p aria-live="polite" className="min-h-4 tabular-nums">
          {readout === null ? "Hover or tap a cell for counts" : <span className="text-foreground">{readout}</span>}
        </p>
        <div className="flex items-center gap-2">
          <span>Fewer</span>
          <span aria-hidden className="h-2 w-20 rounded-full" style={{ background: "linear-gradient(to right, var(--heat-lo), var(--heat-hi))" }} />
          <span className="tabular-nums">More (max {fmt(max)})</span>
        </div>
      </div>
    </div>
  )
}

export function HeatmapCard({ heatmap, harness }: { heatmap: Loaded<HeatCell[]>; harness: string | null }) {
  const cells = heatmap.data ?? []
  const ordered = [...cells].sort((a, b) => DAY_ORDER.indexOf(a.weekday) - DAY_ORDER.indexOf(b.weekday) || a.hour - b.hour)
  return (
    <Panel
      title="Busiest hours"
      description={`Events per hour, server time${harness ? `, ${harnessMeta(harness).label} only` : ""}`}
      status={status(heatmap.data, (d) => d.length === 0)}
      stale={heatmap.loading && heatmap.data !== undefined}
      chart={() => <HeatGrid cells={cells} />}
      table={() => (
        <DataTable
          label="Events by weekday and hour"
          rows={ordered}
          rowKey={(c) => `${c.weekday}-${c.hour}`}
          maxHeight={320}
          columns={[
            { key: "weekday", label: "Day", cell: (c) => DAY_NAMES[c.weekday] },
            { key: "hour", label: "Hour", cell: (c) => `${pad2(c.hour)}:00` },
            { key: "events", label: "Events", num: true, cell: (c) => fmt(c.events) },
            { key: "prompts", label: "Prompts", num: true, cell: (c) => fmt(c.prompts) },
          ]}
        />
      )}
    />
  )
}
