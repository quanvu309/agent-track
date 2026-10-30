import { displayTitle } from "./session-title.ts"
import { shortPath } from "./format.ts"
import type { ThreadRow } from "./types.ts"

export const LIVE_WINDOW_MIN = 15

export const isLive = (last: string | null, now: number) => last !== null && now - Date.parse(last) < LIVE_WINDOW_MIN * 60_000

/** Relative time for a glance: "Just now", "12 min ago", "5 h ago", "Yesterday", then a date. */
export function since(ts: string | null, now: number): string {
  if (!ts) return ""
  const t = Date.parse(ts)
  const min = Math.floor((now - t) / 60_000)
  if (min < 1) return "Just now"
  if (min < 60) return `${min} min ago`
  if (min < 24 * 60) return `${Math.floor(min / 60)} h ago`
  const day = (d: number) => new Date(d).toDateString()
  if (day(now - 864e5) === day(t)) return "Yesterday"
  const sameYear = new Date(now).getFullYear() === new Date(t).getFullYear()
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })
}

function tail(p: string | null, n: number): string {
  const parts = shortPath(p).split("/").filter(Boolean)
  return parts.length <= n ? shortPath(p) : parts.slice(-n).join("/")
}

/** The last two folders of a project path, e.g. "projects/acme". Home-level folders keep "~/". */
export const projectTail = (p: string | null) => tail(p, 2)

/** Short names for a set of project paths: two folders each, more where two paths would read the same. */
export function projectNames(paths: (string | null)[]): (p: string | null) => string {
  const unique = [...new Set(paths)]
  const names = new Map<string | null, string>()
  for (const p of unique) {
    let n = 2
    while (unique.some((q) => q !== p && tail(q, n) === tail(p, n)) && tail(p, n) !== shortPath(p)) n += 1
    names.set(p, tail(p, n))
  }
  return (p) => names.get(p) ?? projectTail(p)
}

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ThreadNode = ThreadRow & { depth: number; name: string; label: string; muted: boolean }

/** Threads in tree order, root first and children by start time. `name` is short ("Sub-agent 3"), `label` adds the model. Untitled subagents are numbered in tree order. */
export function threadTree(threads: ThreadRow[], rootId: string): ThreadNode[] {
  const children = new Map<string | null, ThreadRow[]>()
  for (const t of threads) children.set(t.parent_thread_id, [...(children.get(t.parent_thread_id) ?? []), t])
  for (const list of children.values()) list.sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""))
  const known = new Set(threads.map((t) => t.thread_id))
  const tops = threads.filter((t) => !t.parent_thread_id || !known.has(t.parent_thread_id))
  tops.sort((a, b) => Number(b.thread_id === rootId) - Number(a.thread_id === rootId) || (a.started_at ?? "").localeCompare(b.started_at ?? ""))
  const out: ThreadNode[] = []
  let subagent = 0
  const walk = (t: ThreadRow, depth: number) => {
    const named = t.title && !UUID_LIKE.test(t.title.trim()) && t.title.trim() !== t.thread_id
    const withModel = (name: string) => (t.model ? `${name} · ${t.model}` : name)
    if (t.thread_id === rootId) out.push({ ...t, depth, name: "Main thread", label: withModel("Main thread"), muted: false })
    else if (named) {
      const { text, muted } = displayTitle(t.title)
      out.push({ ...t, depth, name: text, label: text, muted })
    } else {
      subagent += 1
      out.push({ ...t, depth, name: `Sub-agent ${subagent}`, label: withModel(`Sub-agent ${subagent}`), muted: false })
    }
    for (const c of children.get(t.thread_id) ?? []) walk(c, depth + 1)
  }
  for (const t of tops) walk(t, 0)
  return out
}
