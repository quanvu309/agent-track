import { useState } from "react"

import { DataTable } from "@/components/data-table"
import { HarnessLegend, Panel, Segmented } from "@/components/kit"
import { DayChart, type HourPoint, PLOT_LEFT, YesterdayKey } from "@/components/now-chart"
import { SessionLanes } from "@/components/now-timeline"
import { status } from "@/lib/panel-status"
import { type Loaded, useApi } from "@/lib/api"
import { compact, fmt, hourLabel, pad2, shiftDay } from "@/lib/format"
import { qs } from "@/lib/range"
import { harnessMeta } from "@/lib/harness"
import { lanesNote, useTodaySessions } from "@/lib/now-sessions"
import { dayHours, useClock } from "@/lib/now-time"
import { WIDE, useMedia } from "@/lib/use-media"
import { type Today, parseToday } from "@/lib/types"

const TODAY_METRICS = [
  ["sessions", "Sessions"],
  ["prompts", "Prompts"],
  ["tool_calls", "Tool calls"],
  ["input_tokens", "Input"],
  ["output_tokens", "Output"],
] as const
type TodayMetric = (typeof TODAY_METRICS)[number][0]

const NOUN: Record<TodayMetric, string> = { sessions: "sessions", prompts: "prompts", tool_calls: "tool calls", input_tokens: "input tokens", output_tokens: "output tokens" }

const HOURS = Array.from({ length: 24 }, (_, i) => i)

function hourPoints(today: Today | undefined, prior: Today | undefined, series: string[], metric: TodayMetric): HourPoint[] {
  const points: HourPoint[] = HOURS.map((hour) => ({ hour, values: {}, total: 0, yesterday: prior ? 0 : null }))
  for (const r of today?.rows ?? []) {
    if (!series.includes(r.harness)) continue
    const p = points[r.hour]
    p.values[r.harness] = r[metric]
    p.total += r[metric]
  }
  for (const r of prior?.rows ?? []) {
    if (series.includes(r.harness)) points[r.hour].yesterday! += r[metric]
  }
  return points
}

export function TodayCard({ today, series, onOpen }: { today: Loaded<Today>; series: string[]; onOpen: (id: string) => void }) {
  const [metric, setMetric] = useState<TodayMetric>("tool_calls")
  const clock = useClock(30_000)
  const day = today.data?.day
  const prior = useApi(day ? `/api/today${qs({ day: shiftDay(day, -1) })}` : null, parseToday)
  const metricLabel = TODAY_METRICS.find(([k]) => k === metric)![1]
  const points = hourPoints(today.data, prior.data, series, metric)
  const nowAt = day ? dayHours(day, clock) : -1
  const wide = useMedia(WIDE)
  const sessions = useTodaySessions(wide ? day : undefined, (h) => series.includes(h))
  const busiest = points.reduce((best, p) => (p.total > best.total ? p : best), points[0])
  const num = metric.endsWith("_tokens") ? compact : fmt
  // A session active in several hours counts in each hour, so only the other metrics have a meaningful day total.
  const summary = busiest.total === 0
    ? <>No {NOUN[metric]} yet today</>
    : metric === "sessions"
    ? <>Busiest hour {pad2(busiest.hour)}:00, {fmt(busiest.total)} sessions</>
    : <>{num(points.reduce((a, p) => a + p.total, 0))} {NOUN[metric]}, busiest {pad2(busiest.hour)}:00<span className="max-sm:hidden"> with {num(busiest.total)}</span></>

  return (
    <Panel
      // Phones keep the first Live now row above the tab bar. Desktop leaves room under the chart for the first session lanes.
      className="[--today-h:140px] sm:[--today-h:180px] lg:[--today-h:clamp(220px,calc(100dvh_-_620px),320px)]"
      title="Today"
      description={today.data ? <><span className="font-medium text-foreground">{summary}</span><span className="max-sm:hidden"> · server time</span></> : "Server time"}
      controls={<Segmented label="Today metric" fill className="sm:w-auto" options={TODAY_METRICS} value={metric} onChange={setMetric} />}
      legend={
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <HarnessLegend ids={series} />
          {prior.data ? <YesterdayKey /> : null}
        </div>
      }
      status={status(today.data, (d) => !d.rows.some((r) => series.includes(r.harness)))}
      stale={today.loading && today.data !== undefined}
      chart={() => (
        <div className="grid gap-3">
          <DayChart
            points={points}
            series={series}
            now={nowAt}
            height="var(--today-h)"
            ariaLabel={`${metricLabel} per hour today, stacked by harness${prior.data ? ", with yesterday as a line" : ""}`}
          />
          {wide && day && sessions.data?.length ? (
            <section aria-label="Sessions today" className="grid gap-1.5 border-t pt-3">
              <h3 className="text-xs text-muted-foreground" style={{ paddingLeft: PLOT_LEFT }}>
                <span className="font-semibold text-foreground">Sessions</span> · {lanesNote(sessions.data, clock)}
              </h3>
              <SessionLanes rows={sessions.data} day={day} now={clock} onOpen={onOpen} />
            </section>
          ) : null}
        </div>
      )}
      table={() => (
        <DataTable
          label={`${metricLabel} per hour today`}
          rows={points.filter((p) => p.total > 0 || (p.yesterday ?? 0) > 0)}
          rowKey={(p) => String(p.hour)}
          maxHeight={280}
          columns={[
            { key: "hour", label: "Hour", cell: (p) => hourLabel(p.hour) },
            ...series.map((h) => ({ key: h, label: harnessMeta(h).label, num: true, cell: (p: HourPoint) => fmt(p.values[h] ?? 0) })),
            { key: "total", label: "Total", num: true, cell: (p) => fmt(p.total) },
            ...(prior.data ? [{ key: "yesterday", label: "Yesterday", num: true, cell: (p: HourPoint) => fmt(p.yesterday) }] : []),
          ]}
        />
      )}
    />
  )
}
