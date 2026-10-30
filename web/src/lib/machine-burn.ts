import type { BurnRow, HourlyRow } from "./types"

type Tokens = { input_tokens: number; cached_tokens: number; output_tokens: number }

/** Burn is new input plus output. Cached input is context the model re-reads, so it only counts when asked. */
export const burnOf = (r: Tokens, withCached = false) => r.input_tokens - r.cached_tokens + r.output_tokens + (withCached ? r.cached_tokens : 0)

const MIN = 60_000
export const BIN_MINUTES = 5
export const BINS = 24
/** One request feeds the rates and the 2 hour chart. It covers the 24 bins plus the partial first one. */
export const BURN_URL = `/api/burn?minutes=${BINS * BIN_MINUTES + BIN_MINUTES}&bucket=1`

export type Rate = { burn: number; cached: number; start: number; end: number }

/** Tokens per minute over the last `minutes` whole minutes, so the running minute never drags the rate down. */
export function rateOver(rows: BurnRow[], until: string, minutes: number): Rate {
  const end = Math.floor(Date.parse(until) / MIN) * MIN
  const start = end - minutes * MIN
  let burn = 0
  let cached = 0
  for (const r of rows) {
    const t = Date.parse(r.ts)
    if (t < start || t >= end) continue
    burn += burnOf(r)
    cached += r.cached_tokens
  }
  return { burn: burn / minutes, cached: cached / minutes, start, end }
}

export type Bin = { start: number; partial: boolean; values: Record<string, number> }

/** The last 24 five-minute bins by agent. The newest bin is still running. */
export function burnBins(rows: BurnRow[], until: string, withCached: boolean): Bin[] {
  const size = BIN_MINUTES * MIN
  const first = (Math.floor(Date.parse(until) / size) - (BINS - 1)) * size
  const bins: Bin[] = Array.from({ length: BINS }, (_, i) => ({ start: first + i * size, partial: i === BINS - 1, values: {} }))
  for (const r of rows) {
    const bin = bins[Math.floor((Date.parse(r.ts) - first) / size)]
    if (bin) bin.values[r.harness] = (bin.values[r.harness] ?? 0) + burnOf(r, withCached)
  }
  return bins
}

export type DayPoint = { hour: number; today: number | null; yesterday: number | null; todayHour: number; yesterdayHour: number | null }

/** Running burn totals by hour. Today stops at the running hour. */
export function dayCurves(today: HourlyRow[], yesterday: HourlyRow[] | undefined, nowHour: number): DayPoint[] {
  const perHour = (rows: HourlyRow[]) => {
    const sums = Array<number>(24).fill(0)
    for (const r of rows) sums[r.hour] += burnOf(r)
    return sums
  }
  const t = perHour(today)
  const y = yesterday ? perHour(yesterday) : null
  let tc = 0
  let yc = 0
  return t.map((v, hour) => {
    tc += v
    if (y) yc += y[hour]
    return { hour, today: hour <= nowHour ? tc : null, yesterday: y ? yc : null, todayHour: v, yesterdayHour: y ? y[hour] : null }
  })
}
