import { useEffect, useState } from "react"

export function useClock(everyMs: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}

/** Hours from the local midnight that starts `day` to `t`. Below 0 before the day, 24 or more after it. */
export const dayHours = (day: string, t: number) => (t - new Date(`${day}T00:00:00`).getTime()) / 3_600_000

export const secondsSince = (ts: string | null, now: number) => (ts ? Math.max(0, (now - Date.parse(ts)) / 1000) : Infinity)

export function since(ts: string | null, now: number): string {
  const s = secondsSince(ts, now)
  if (s === Infinity) return ""
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}
