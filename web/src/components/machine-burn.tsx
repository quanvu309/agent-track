import { useState } from "react"
import { CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts"

import { StackedColumns, TipBox } from "@/components/charts"
import { DataTable } from "@/components/data-table"
import { HarnessLegend, Panel, Segmented } from "@/components/kit"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import { compact, fmt, hourLabel, pad2 } from "@/lib/format"
import { HARNESS, HARNESS_CHART_CONFIG, harnessMeta } from "@/lib/harness"
import { BIN_MINUTES, type Bin, type DayPoint, burnBins, dayCurves, rateOver } from "@/lib/machine-burn"
import { status } from "@/lib/panel-status"
import { dayHours, useClock } from "@/lib/now-time"
import type { Burn, Today } from "@/lib/types"

const ORDER: string[] = Object.keys(HARNESS)
const byOrder = (ids: Iterable<string>) => [...new Set(ids)].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b))

const hhmm = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })
const binTitle = (b: Bin) => `${hhmm(b.start)} to ${hhmm(b.start + BIN_MINUTES * 60_000)}${b.partial ? ", so far" : ""}`
const binTotal = (b: Bin) => Object.values(b.values).reduce((a, v) => a + v, 0)

const RATE_SIZE = { hero: "text-2xl leading-8", main: "text-xl leading-7", side: "text-lg leading-7" } as const

function Rate({ value, label, size }: { value: number; label: string; size: keyof typeof RATE_SIZE }) {
  return (
    <div className="grid gap-0.5">
      <div className="flex items-baseline gap-1">
        <span className={`${RATE_SIZE[size]} font-semibold tracking-tight`}>{compact(value)}</span>
        <span className="text-[13px] text-muted-foreground">/min</span>
      </div>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

export function BurnCard({ burn, className }: { burn: Burn | undefined; className?: string }) {
  const [mode, setMode] = useState<"burn" | "cached">("burn")
  const withCached = mode === "cached"
  const r5 = burn && rateOver(burn.rows, burn.until, 5)
  const r15 = burn && rateOver(burn.rows, burn.until, 15)
  const bins = burn ? burnBins(burn.rows, burn.until, withCached) : []
  const series = byOrder(burn?.rows.map((r) => r.harness) ?? [])
  return (
    <Panel
      className={className}
      title="Token burn"
      description={
        <div className="grid gap-3 pt-2">
          {r5 && r15 ? (
            <div className="flex flex-wrap items-end gap-x-6 gap-y-2 text-foreground" data-figure="burn" data-r5={r5.burn} data-r15={r15.burn} data-c5={r5.cached}>
              <Rate value={r5.burn} label="Last 5 min" size="hero" />
              <Rate value={r15.burn} label="Last 15 min" size="main" />
              <Rate value={r5.cached} label="Cached, 5 min" size="side" />
            </div>
          ) : null}
          <p className="text-xs leading-5">Burn is new input plus output tokens. Cached input is context the model re-reads, so it stays out unless you add it.</p>
        </div>
      }
      controls={
        <Segmented
          label="Cached input"
          value={mode}
          onChange={setMode}
          options={[
            ["burn", "Burn"],
            ["cached", "Burn + cached"],
          ]}
        />
      }
      legend={<HarnessLegend ids={series} />}
      status={status(burn, (b) => b.rows.length === 0)}
      emptyText="No tokens in the last 2 hours"
      skeletonHeight={180}
      chart={() => (
        <div className="grid gap-1">
          <StackedColumns
            categories={bins.map((_, i) => i)}
            series={series}
            value={(i, h) => bins[i].values[h] ?? 0}
            tick={(i) => hhmm(bins[i].start)}
            title={(i) => binTitle(bins[i])}
            ariaLabel={`${withCached ? "Burn plus cached input" : "Burn"} per 5 minutes over the last 2 hours, by agent`}
            height={180}
            labelTotals="peak"
            tickWidth={48}
            barSize={14}
          />
          <p className="text-xs text-muted-foreground">Per 5 minutes, last 2 hours. The last column is still running.</p>
        </div>
      )}
      table={() => (
        <DataTable
          label="Burn per 5 minutes"
          maxHeight={320}
          rows={[...bins].reverse()}
          rowKey={(b) => String(b.start)}
          columns={[
            { key: "time", label: "Time", cell: binTitle },
            ...series.map((h) => ({ key: h, label: harnessMeta(h).label, num: true, cell: (b: Bin) => fmt(b.values[h] ?? 0) })),
            { key: "total", label: "Total", num: true, cell: (b: Bin) => fmt(binTotal(b)) },
          ]}
        />
      )}
    />
  )
}

const TODAY = "var(--foreground)"
const YESTERDAY = "var(--muted-foreground)"

function LineKey({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <span aria-hidden className="h-0.5 w-3.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}

function change(today: number, yesterday: number) {
  if (!yesterday) return null
  const d = (today - yesterday) / yesterday
  return `${d >= 0 ? "+" : "−"}${Math.round(Math.abs(d) * 100)}%`
}

export function DayCard({ today, yesterday, className }: { today: Today | undefined; yesterday: Today | undefined; className?: string }) {
  const clock = useClock(60_000)
  const nowHour = today ? Math.floor(dayHours(today.day, clock)) : 0
  const points = today ? dayCurves(today.rows, yesterday?.rows, nowHour) : []
  // Whole hours only, so a running hour is never compared with a finished one.
  const done = points[nowHour - 1]
  const delta = done && done.yesterday !== null ? change(done.today ?? 0, done.yesterday) : null
  const summary = !done ? (
    "Running burn by hour, server time"
  ) : (
    <span data-figure="day" data-today={done.today ?? 0} data-yesterday={done.yesterday ?? ""}>
      By {hourLabel(nowHour)}, <span className="font-medium text-foreground">{compact(done.today ?? 0)} today</span>
      {done.yesterday !== null ? <>, {compact(done.yesterday)} yesterday{delta ? ` (${delta})` : ""}</> : null}
    </span>
  )
  return (
    <Panel
      className={className}
      title="Today vs yesterday"
      description={summary}
      legend={
        <div className="flex gap-4">
          <LineKey color={TODAY} label="Today" />
          {yesterday ? <LineKey color={YESTERDAY} label="Yesterday" /> : null}
        </div>
      }
      status={status(today, () => false)}
      skeletonHeight={160}
      chart={() => (
        <div role="figure" aria-label="Running burn total by hour, today and yesterday">
          <ChartContainer config={HARNESS_CHART_CONFIG} className="aspect-auto h-40 w-full">
            <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} accessibilityLayer>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey="hour" tickLine={false} axisLine={{ stroke: "var(--border)" }} tickMargin={8} interval={5} tickFormatter={pad2} className="tabular-nums" />
              <YAxis tickLine={false} axisLine={false} width={44} tickMargin={4} tickFormatter={(v: number) => compact(v)} className="tabular-nums" />
              <ChartTooltip
                cursor={{ stroke: "var(--border)" }}
                content={({ active, payload }) => {
                  const p = active ? (payload?.[0]?.payload as DayPoint | undefined) : undefined
                  if (!p) return null
                  return (
                    <TipBox
                      title={`${hourLabel(p.hour)} to ${hourLabel((p.hour + 1) % 24)}${p.hour === nowHour ? ", so far" : ""}`}
                      rows={[
                        ...(p.today !== null ? [{ label: "Today, running", value: compact(p.today), color: TODAY, strong: true }, { label: "Today, this hour", value: compact(p.todayHour) }] : []),
                        ...(p.yesterday !== null ? [{ label: "Yesterday, running", value: compact(p.yesterday), color: YESTERDAY }, { label: "Yesterday, this hour", value: compact(p.yesterdayHour ?? 0) }] : []),
                      ]}
                    />
                  )
                }}
              />
              <Line dataKey="yesterday" type="linear" stroke={YESTERDAY} strokeWidth={1.5} dot={false} activeDot={{ r: 4, fill: YESTERDAY, stroke: "var(--card)", strokeWidth: 2 }} isAnimationActive={false} />
              <Line
                dataKey="today"
                type="linear"
                stroke={TODAY}
                strokeWidth={2}
                connectNulls={false}
                dot={(p: { cx?: number; cy?: number; index?: number }) =>
                  p.index === nowHour ? <circle key="end" cx={p.cx} cy={p.cy} r={4} fill={TODAY} stroke="var(--card)" strokeWidth={2} /> : <g key={p.index} />
                }
                activeDot={{ r: 4, fill: TODAY, stroke: "var(--card)", strokeWidth: 2 }}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ChartContainer>
        </div>
      )}
      table={() => (
        <DataTable
          label="Burn by hour"
          maxHeight={320}
          rows={points.filter((p) => p.today !== null || p.yesterday !== null)}
          rowKey={(p) => String(p.hour)}
          columns={[
            { key: "hour", label: "Hour", cell: (p) => hourLabel(p.hour) },
            { key: "today", label: "Today", num: true, cell: (p) => (p.today === null ? "" : fmt(p.todayHour)) },
            { key: "yesterday", label: "Yesterday", num: true, cell: (p) => (p.yesterdayHour === null ? "" : fmt(p.yesterdayHour)) },
          ]}
        />
      )}
    />
  )
}
