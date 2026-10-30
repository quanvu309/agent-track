import { statusOf } from "./fleet.ts"
import type { Domain } from "./session-layout.ts"
import type { PresenceState } from "./types.ts"

export type Life = { start: number; end: number; working: boolean; harness: string }

export function lifeOf(r: { first: string | null; started: string | null; last: string | null; harness: string; state?: PresenceState | null }, now: number): Life | null {
  const from = r.first ?? r.started
  if (!from) return null
  const start = Date.parse(from)
  return { start, end: r.last ? Math.max(start, Date.parse(r.last)) : start, working: statusOf(r, now) === "working", harness: r.harness }
}

/** The shared clock for a list of sessions: earliest start to latest activity. */
export function lifeDomain(lives: (Life | null)[]): Domain | null {
  const known = lives.filter((l) => l !== null)
  if (!known.length) return null
  return { start: Math.min(...known.map((l) => l.start)), end: Math.max(...known.map((l) => l.end)) }
}

/** The start of a session in a few characters: a clock time today, a date before. */
export function startedText(life: Life, now: number): string {
  const d = new Date(life.start)
  if (d.toDateString() === new Date(now).toDateString()) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}
