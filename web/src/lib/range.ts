import { ymd } from "./format"

export type RangeSel =
  | { kind: "all" }
  | { kind: "last"; days: 7 | 30; since: string }
  | { kind: "custom"; since: string; until: string }

export const ALL_TIME: RangeSel = { kind: "all" }

export function lastDays(days: 7 | 30): RangeSel {
  return { kind: "last", days, since: ymd(new Date(Date.now() - (days - 1) * 864e5)) }
}

export function custom(since: string, until: string): RangeSel {
  return since || until ? { kind: "custom", since, until } : ALL_TIME
}

export function bounds(r: RangeSel): { since: string; until: string } {
  switch (r.kind) {
    case "all":
      return { since: "", until: "" }
    case "last":
      return { since: r.since, until: "" }
    case "custom":
      return { since: r.since, until: r.until }
  }
}

export function rangeError(r: RangeSel): string | null {
  return r.kind === "custom" && r.since && r.until && r.since > r.until ? "Start date is after end date." : null
}

export function rangeText(r: RangeSel): string {
  const { since, until } = bounds(r)
  return !since && !until ? "All time" : `${since || "start"} to ${until || "today"}`
}

export function qs(params: Record<string, string | number | null | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ""
}
