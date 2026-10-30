/** What a thread is doing right now. The server reads the process and the transcript when it has evidence (`state`); the age of the last event is only the fallback. One place decides, every surface renders by lookup. */

import { secondsSince } from "./now-time.ts"
import { HARNESS, harnessMeta } from "./harness.ts"
import { type ThreadNode, threadTree } from "./session-format.ts"
import { type Domain, packLanes } from "./session-layout.ts"
import type { DailyRow, LiveRow, PresenceState, Today } from "./types.ts"

export type ThreadStatus = "working" | "waiting" | "ended"

// Fallback only, for rows the server has no process or transcript evidence for. Ingest runs every 60 s and the page polls every 20 s, so a thread that never stops can still read about 80 s old.
export const WORKING_S = 120
export const WAITING_S = 15 * 60

export const STATUS = {
  working: { label: "Working", hint: "A turn is in progress", rank: 0 },
  waiting: { label: "Idle", hint: "Open, turn finished, waiting for the next message", rank: 1 },
  ended: { label: "Ended", hint: "Process gone, or no events for 15 minutes", rank: 2 },
} as const satisfies Record<ThreadStatus, { label: string; hint: string; rank: number }>

export const STATUS_ORDER = ["working", "waiting", "ended"] as const satisfies readonly ThreadStatus[]

/** What statusOf reads: the last event time, and the server's state when it has evidence. */
export type StatusInput = { last: string | null; state?: PresenceState | null }

const FROM_STATE: Record<PresenceState, ThreadStatus> = { working: "working", idle: "waiting", ended: "ended" }

export function statusOf({ last, state }: StatusInput, now: number): ThreadStatus {
  if (state) return FROM_STATE[state]
  const s = secondsSince(last, now)
  if (s < WORKING_S) return "working"
  if (s < WAITING_S) return "waiting"
  return "ended"
}

/** Status counts in STATUS_ORDER, for group headers and the sidebar badge. */
export function countStatus(rows: StatusInput[], now: number): Record<ThreadStatus, number> {
  const out: Record<ThreadStatus, number> = { working: 0, waiting: 0, ended: 0 }
  for (const row of rows) out[statusOf(row, now)] += 1
  return out
}

/** Two-letter team code per harness, the way Linear prefixes an issue id with its team. */
export const TEAM: Record<string, string> = { claude: "CL", codex: "CX", grok: "GK" }
const teamOf = (harness: string) => (Object.hasOwn(TEAM, harness) ? TEAM[harness] : "??")

/** `CL-6b11`: team code and four characters of the session id. Codex ids are UUIDv7, whose first characters are a timestamp shared by every recent session, so those use the last four. */
export function threadKey(row: LiveRow): string {
  const id = row.session_id.toLowerCase()
  const v7 = id[14] === "7"
  return `${teamOf(row.harness)}-${v7 ? id.slice(-4) : id.slice(0, 4)}`
}

/** `CL-6b11.3`: the third sub-agent of a session, counted in tree order. */
export const subKey = (parentKey: string, index: number) => `${parentKey}.${index}`

/** The assignee of a thread: a two-letter mark and the full model name for its tooltip. */
const MODEL_FAMILIES = [["opus", "Op"], ["sonnet", "So"], ["haiku", "Ha"], ["fable", "Fa"], ["luna", "Lu"], ["grok", "Gk"]] as const

export function modelMark(model: string | null): { mark: string; label: string } {
  if (!model) return { mark: "?", label: "Unknown model" }
  const m = model.toLowerCase()
  const family = MODEL_FAMILIES.find(([name]) => m.includes(name))
  if (family) return { mark: family[1], label: model }
  const gpt = /gpt-?(\d)/.exec(m)
  return { mark: gpt ? `G${gpt[1]}` : "?", label: model }
}

/** A thread with its status and identifier read once, so a row never re-derives them. */
export type BoardThread = ThreadNode & { status: ThreadStatus; key: string }

/** One session as the board and the timeline both read it. */
export type BoardSession = {
  row: LiveRow
  /** The identifier, `CL-6b11`. */
  key: string
  status: ThreadStatus
  /** Every thread in tree order, the main thread first. */
  tree: BoardThread[]
  /** The tree without the main thread, still in tree order. */
  subagents: BoardThread[]
  subStatuses: ThreadStatus[]
  /** The model the session used last. */
  model: string | null
}

export type BoardGroup = { status: ThreadStatus; sessions: BoardSession[] }

const lastModel = (models: string | null) => models?.split(",").map((m) => m.trim()).filter(Boolean).at(-1) ?? null

export function boardSession(row: LiveRow, now: number): BoardSession {
  const key = threadKey(row)
  let sub = 0
  const tree = threadTree(row.thread_rows, row.session_id).map((n) => ({
    ...n,
    status: statusOf({ last: n.last ?? n.started_at, state: n.state }, now),
    key: n.thread_id === row.session_id ? key : subKey(key, ++sub),
  }))
  const subagents = tree.filter((n) => n.thread_id !== row.session_id)
  return { row, key, status: statusOf(row, now), tree, subagents, subStatuses: subagents.map((n) => n.status), model: lastModel(row.models) }
}

/** Sub-agents that ended, out of all of them: the `3/5` chip. */
export function subProgress(session: BoardSession): { done: number; total: number } {
  return { done: session.subStatuses.filter((s) => s === "ended").length, total: session.subStatuses.length }
}

/** Seconds a thread ran, first to last event. */
export const threadRan = (t: { started_at: string | null; last: string | null }) =>
  t.started_at && t.last ? Math.max(0, (Date.parse(t.last) - Date.parse(t.started_at)) / 1000) : 0

const newestFirst = (a: BoardSession, b: BoardSession) => (b.row.last ?? "").localeCompare(a.row.last ?? "")

/** The live statuses in STATUS_ORDER, each with its sessions newest first. Ended sessions belong to the Sessions view. Empty groups stay, the view decides which to show. */
function statusGroups(sessions: BoardSession[]): BoardGroup[] {
  return STATUS_ORDER.filter((status) => status !== "ended").map((status) => ({ status, sessions: sessions.filter((s) => s.status === status).sort(newestFirst) }))
}

export type GroupBy = "status" | "agent" | "project"

export type Group = {
  key: string
  label: string
  /** What the group header draws: a status glyph, a harness dot or a folder. */
  icon: GroupBy
  status?: ThreadStatus
  harness?: string
  sessions: BoardSession[]
}

const newestGroup = (a: Group, b: Group) => newestFirst(a.sessions[0], b.sessions[0])

const HARNESS_ORDER: string[] = Object.keys(HARNESS)
const harnessRank = (id: string) => (HARNESS_ORDER.includes(id) ? HARNESS_ORDER.indexOf(id) : HARNESS_ORDER.length)

/** Sessions in groups, each newest first. Status keeps every status (the view hides empty ones), agents follow the harness registry, projects the most recent first. Agent and project groups are never empty. */
export function groupBy(sessions: BoardSession[], by: GroupBy, names: (project: string | null) => string): Group[] {
  if (by === "status") {
    return statusGroups(sessions).map((g) => ({ key: g.status, label: STATUS[g.status].label, icon: "status", status: g.status, sessions: g.sessions }))
  }
  const buckets = new Map<string, BoardSession[]>()
  for (const s of sessions) {
    const k = by === "agent" ? s.row.harness : (s.row.project ?? "")
    buckets.set(k, [...(buckets.get(k) ?? []), s])
  }
  const groups = [...buckets].map(([k, list]): Group => {
    const sorted = list.sort(newestFirst)
    return by === "agent"
      ? { key: `agent:${k}`, label: harnessMeta(k).label, icon: "agent", harness: k, sessions: sorted }
      : { key: `project:${k}`, label: names(k || null), icon: "project", sessions: sorted }
  })
  return by === "agent"
    ? groups.sort((a, b) => harnessRank(a.harness ?? "") - harnessRank(b.harness ?? "") || a.label.localeCompare(b.label))
    : groups.sort(newestGroup)
}

export type LaneChild = {
  node: BoardThread
  /** Epoch ms, clipped to the domain. */
  start: number
  end: number
  depth: number
  /** Sub-row under the main bar, counted across depths: depth 1 first, then depth 2. */
  lane: number
}

export type TimelineLane = {
  session: BoardSession
  /** The main bar in epoch ms, clipped to the domain. */
  root: Domain
  children: LaneChild[]
  /** How many sub-rows the children take. */
  subRows: number
}

const clamp = (d: Domain, t: number) => Math.min(d.end, Math.max(d.start, t))

/** One lane per session in group order. Sub-agents pack per depth so overlapping ones stack; `gapMs` is the least time between two bars sharing a sub-row. */
export function timelineLanes(groups: { sessions: BoardSession[] }[], domain: Domain, gapMs: number): TimelineLane[] {
  return groups.flatMap((g) => g.sessions).map((session) => {
    const { row } = session
    const first = Date.parse(row.first ?? row.started ?? row.last ?? "")
    const last = Date.parse(row.last ?? row.first ?? "")
    const timed = session.subagents.flatMap((node) => {
      if (!node.started_at) return []
      const start = Date.parse(node.started_at)
      const end = node.last ? Math.max(start, Date.parse(node.last)) : start
      return end < domain.start || start > domain.end ? [] : [{ node, start: clamp(domain, start), end: clamp(domain, end) }]
    })
    const children: LaneChild[] = []
    let base = 0
    for (const depth of [...new Set(timed.map((t) => t.node.depth))].sort((a, b) => a - b)) {
      const level = timed.filter((t) => t.node.depth === depth)
      const { lanes, count } = packLanes(level, gapMs)
      level.forEach((t, i) => children.push({ ...t, depth, lane: base + lanes[i] }))
      base += count
    }
    return { session, root: { start: clamp(domain, first), end: clamp(domain, last) }, children, subRows: base }
  })
}

/** Working and waiting sessions per harness, for the status strip. */
export function harnessActivity(rows: LiveRow[], now: number): Record<string, { working: number; waiting: number }> {
  const out: Record<string, { working: number; waiting: number }> = {}
  for (const r of rows) {
    const s = statusOf(r, now)
    const slot = (out[r.harness] ??= { working: 0, waiting: 0 })
    if (s !== "ended") slot[s] += 1
  }
  return out
}

/** Today's totals for the agents in `inView`: sessions started, tool calls, output tokens. */
export function todayFigures(today: Today, daily: DailyRow[], inView: string[]): { sessions: number; toolCalls: number; outputTokens: number } {
  const mine = today.rows.filter((r) => inView.includes(r.harness))
  return {
    sessions: daily.filter((r) => r.day === today.day && inView.includes(r.harness)).reduce((a, r) => a + r.sessions, 0),
    toolCalls: mine.reduce((a, r) => a + r.tool_calls, 0),
    outputTokens: mine.reduce((a, r) => a + r.output_tokens, 0),
  }
}
