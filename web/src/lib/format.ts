export const pad2 = (n: number) => String(n).padStart(2, "0")

export const fmt = (n: number | null | undefined) => (n == null ? "" : n.toLocaleString("en-US"))

export function compact(n: number): string {
  const abs = Math.abs(n)
  for (const [limit, suffix] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (abs >= limit) {
      const v = n / limit
      return (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)).replace(/\.0$/, "") + suffix
    }
  }
  return String(Math.round(n))
}

export const when = (ts: string | null) =>
  ts ? new Date(ts).toLocaleString("en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : ""

export const whenSec = (ts: string | null) => (ts ? new Date(ts).toLocaleTimeString("en-GB", { hour12: false }) : "")

export const dayLabel = (day: string) =>
  new Date(day + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

export const longDay = (day: string) =>
  new Date(day + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })

export const shiftDay = (day: string, by: number) => new Date(Date.parse(day + "T00:00:00Z") + by * 864e5).toISOString().slice(0, 10)

export const hourLabel = (hour: number) => `${pad2(hour)}:00`

export const shortPath = (p: string | null) => (p || "No project").replace(/^\/home\/[^/]+\//, "~/")

export function dur(sec: number): string {
  const s = Math.round(sec)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h ${pad2(Math.floor((s % 3600) / 60))}m`
}

export function fmtMs(ms: number | null): string {
  if (ms == null) return ""
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`
  return `${(ms / 60000).toFixed(1)} min`
}

export function ago(ts: string | null, now: number): string {
  if (!ts) return ""
  const sec = Math.max(0, Math.round((now - Date.parse(ts)) / 1000))
  return sec < 60 ? `${sec} s ago` : `${Math.round(sec / 60)} min ago`
}

export const pct = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(1).replace(/\.0$/, "")}%` : "n/a")

export const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

export function daySpan(rows: { day: string }[]): string[] {
  if (!rows.length) return []
  const sorted = rows.map((r) => r.day).sort()
  const days: string[] = []
  const end = Date.parse(sorted[sorted.length - 1] + "T00:00:00Z")
  for (let t = Date.parse(sorted[0] + "T00:00:00Z"); t <= end; t += 864e5) days.push(new Date(t).toISOString().slice(0, 10))
  return days
}
