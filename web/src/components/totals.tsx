import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Spark } from "@/components/charts"
import { compactFixed, pale, tint, wholeShares } from "@/components/insights-format"
import { Meter, ShareBar, type SharePart } from "@/components/insights-marks"
import { HarnessDot } from "@/components/kit"
import type { Loaded } from "@/lib/api"
import { dayLabel, daySpan, fmt, longDay } from "@/lib/format"
import { harnessMeta } from "@/lib/harness"
import { type RangeSel, bounds } from "@/lib/range"
import type { DailyRow, Summary, SummaryHarnessRow } from "@/lib/types"

const COMPOSITION = [
  ["fresh", "Fresh", "Fresh input"],
  ["cached", "Cached", "Cached input"],
  ["output", "Output", "Output"],
] as const

const ACTIVITY = [
  ["prompts", "Prompts"],
  ["tool_calls", "Tool calls"],
] as const
type ActivityKey = (typeof ACTIVITY)[number][0]
/** One agent's part of all agents' activity: the exact fraction for the bar and the whole percent for the label. */
type ActivityShare = Record<ActivityKey, { fraction: number; whole: number }>

function tokenParts(row: SummaryHarnessRow): SharePart[] {
  const base = harnessMeta(row.harness).color
  const colors = { fresh: base, cached: pale(row.harness, 0.89), output: tint(base, 62) }
  const values = { fresh: Math.max(0, row.input_tokens - row.cached_tokens), cached: row.cached_tokens, output: row.output_tokens }
  return COMPOSITION.map(([key, label, longLabel]) => ({
    key,
    label,
    value: values[key],
    color: colors[key],
    valueText: compactFixed(values[key]),
    tip: [
      { label: longLabel, value: fmt(values[key]), color: colors[key], strong: true },
      ...(key === "output" ? [] : [{ label: "All input", value: fmt(row.input_tokens) }]),
    ],
  }))
}

function TotalsCard({ row, activity, days, sessionsOn }: { row: SummaryHarnessRow; activity: ActivityShare; days: string[]; sessionsOn: (day: string) => number }) {
  const color = harnessMeta(row.harness).color
  const tokens = row.input_tokens + row.output_tokens
  return (
    <Card className="h-full gap-0 rounded-lg border border-border py-0 shadow-none">
      <CardContent className="grid gap-4 p-4 sm:p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <HarnessDot id={row.harness} />
          {harnessMeta(row.harness).label}
        </div>
        <div className="flex items-end justify-between gap-4">
          <div>
            <div className="text-2xl leading-8 font-semibold tracking-[-0.01em] tabular-nums" title={fmt(row.sessions)}>{fmt(row.sessions)}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">sessions</div>
          </div>
          {days.length > 1 ? (
            <div className="w-28 sm:w-36">
              <Spark
                points={days.map((d) => ({ key: d, title: longDay(d), value: sessionsOn(d) }))}
                harness={row.harness}
                unit="Sessions"
                ariaLabel={`Sessions per day, ${dayLabel(days[0])} to ${dayLabel(days[days.length - 1])}`}
              />
            </div>
          ) : null}
        </div>
        <section aria-label="Tokens" className="grid gap-1 border-t border-border pt-3.5">
          <h3 className="flex items-baseline justify-between text-xs font-medium text-muted-foreground">
            Tokens
            <span className="text-[13px] font-medium text-foreground tabular-nums" title={fmt(tokens)}>{compactFixed(tokens)}</span>
          </h3>
          <ShareBar label={`${harnessMeta(row.harness).label} tokens split into fresh input, cached input and output`} tipTitle={(p) => `${harnessMeta(row.harness).label} · ${p.label}`} parts={tokenParts(row)} />
        </section>
        <section aria-label="Activity" className="grid gap-2.5 border-t border-border pt-3.5">
          <h3 className="text-xs font-medium text-muted-foreground">Activity</h3>
          {ACTIVITY.map(([k, label]) => (
            <Meter key={k} label={label} value={row[k]} valueText={compactFixed(row[k])} fraction={activity[k].fraction} share={activity[k].whole} color={color} />
          ))}
        </section>
      </CardContent>
    </Card>
  )
}

export function Totals({ summary, daily, range, stale }: { summary: Summary | undefined; daily: Loaded<DailyRow[]>; range: RangeSel; stale: boolean }) {
  const { since, until } = bounds(range)
  const inRange = (daily.data ?? []).filter((r) => r.day >= since && (!until || r.day <= until))
  const days = daySpan(inRange)
  const byKey = new Map(inRange.map((r) => [`${r.day}|${r.harness}`, r.sessions]))
  const rows = summary?.harnesses ?? []
  const wholes = Object.fromEntries(ACTIVITY.map(([k]) => [k, wholeShares(rows.map((r) => r[k]))])) as Record<ActivityKey, number[]>
  const totals = Object.fromEntries(ACTIVITY.map(([k]) => [k, rows.reduce((a, r) => a + r[k], 0)])) as Record<ActivityKey, number>
  const activityOf = (row: SummaryHarnessRow, i: number) =>
    Object.fromEntries(ACTIVITY.map(([k]) => [k, { fraction: totals[k] ? row[k] / totals[k] : 0, whole: wholes[k][i] }])) as ActivityShare
  return (
    // Phones swipe through the agents with the next card peeking in; wider screens lay them side by side.
    <div
      className={`-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 transition-opacity duration-200 [scrollbar-width:none] sm:mx-0 sm:grid sm:grid-cols-2 sm:gap-4 sm:overflow-visible sm:px-0 lg:grid-cols-3 lg:gap-5 ${stale ? "opacity-60" : ""}`}
      aria-busy={stale || !summary}
    >
      {summary
        ? rows.map((row, i) => (
            <div key={row.harness} className="w-[84%] max-w-80 shrink-0 snap-start sm:w-auto sm:max-w-none">
              <TotalsCard row={row} activity={activityOf(row, i)} days={days} sessionsOn={(d) => byKey.get(`${d}|${row.harness}`) ?? 0} />
            </div>
          ))
        : [0, 1, 2].map((i) => <Skeleton key={i} className="h-52 w-[84%] shrink-0 rounded-lg sm:w-auto" />)}
    </div>
  )
}
