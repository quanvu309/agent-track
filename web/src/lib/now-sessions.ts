import { type Loaded, useApi } from "@/lib/api"
import { fmt } from "@/lib/format"
import { dayHours, secondsSince } from "@/lib/now-time"
import { qs } from "@/lib/range"
import { type DisplayTitle, displayTitle } from "@/lib/session-title"
import { type SessionRow, parseSessions } from "@/lib/types"

// Ingest runs every 60 s and Live polls every 20 s, so a session that never stops can still read up to about 80 s old.
export const FRESH_S = 120
const LIVE_S = 15 * 60
export const CAP = 12

/** A session's part of the day: hours since local midnight, clipped to the day. */
export type Lane = {
  id: string
  harness: string
  title: DisplayTitle
  project: string | null
  start: number
  end: number
  activeS: number
  toolCalls: number
  live: boolean
  fresh: boolean
}

export const clip = (h: number) => Math.min(24, Math.max(0, h))

export function toLanes(rows: SessionRow[], day: string, now: number): Lane[] {
  return rows.flatMap((r) => {
    const first = r.first ?? r.started
    if (!first || !r.last) return []
    const ago = secondsSince(r.last, now)
    return [{
      id: r.session_id,
      harness: r.harness,
      title: displayTitle(r.title),
      project: r.project,
      start: clip(dayHours(day, Date.parse(first))),
      end: clip(dayHours(day, Date.parse(r.last))),
      activeS: r.active_s,
      toolCalls: r.tool_calls,
      live: ago < LIVE_S,
      fresh: ago < FRESH_S,
    }]
  })
}

/** Live sessions first, then the busiest, then drawn in start order so the day reads top to bottom. */
export function pick(lanes: Lane[], all: boolean): Lane[] {
  const kept = all ? lanes : [...lanes].sort((a, b) => Number(b.live) - Number(a.live) || b.toolCalls - a.toolCalls || b.activeS - a.activeS).slice(0, CAP)
  return [...kept].sort((a, b) => a.start - b.start || a.end - b.end)
}

/** Today's sessions for the agents in view. The list has no refresh signal of its own, so it polls at the ingest cadence. */
export function useTodaySessions(day: string | undefined, inView: (harness: string) => boolean): Loaded<SessionRow[]> {
  const sessions = useApi(day ? `/api/sessions${qs({ since: day, until: day, limit: 200 })}` : null, parseSessions, 0, 60_000)
  return { ...sessions, data: sessions.data?.filter((r) => inView(r.harness)) }
}

export function lanesNote(rows: SessionRow[], now: number): string {
  const live = rows.filter((r) => secondsSince(r.last, now) < LIVE_S).length
  return `${fmt(rows.length)} today, ${fmt(live)} live`
}
