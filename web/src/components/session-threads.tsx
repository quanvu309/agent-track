import { useState } from "react"
import { ChevronRight } from "lucide-react"
import { cn } from "cn"

import { ShareBar } from "@/components/session-bits"
import { ThreadForks } from "@/components/session-forks"
import { StatusIcon } from "@/components/status-icon"
import { Button } from "@/components/ui/button"
import { compact, dur, fmt } from "@/lib/format"
import { statusOf } from "@/lib/fleet"
import { since } from "@/lib/now-time"
import type { ThreadNode } from "@/lib/session-format"
import { useNow } from "@/lib/session-now"

const PEEK = 12
const INDENT = 20
const MAX_DEPTH = 5
const ROW_PAD = 12

const GRID = "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-3 @3xl:grid-cols-[minmax(0,1fr)_128px_116px_128px_52px_76px]"

function Chevron({ open, name, onClick }: { open: boolean; name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={`${open ? "Collapse" : "Expand"} ${name}`}
      onClick={onClick}
      className="relative inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 before:absolute before:-inset-2 before:content-[''] hover:bg-secondary hover:text-foreground"
    >
      <ChevronRight aria-hidden className={cn("size-3.5 transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")} strokeWidth={2} />
    </button>
  )
}

function Row({ t, now, busiest, kids, open, onToggle }: { t: ThreadNode; now: number; busiest: number; kids: boolean; open: boolean; onToggle: () => void }) {
  const depth = Math.min(t.depth, MAX_DEPTH)
  const root = t.depth === 0
  const status = statusOf(t, now)
  const ran = t.started_at && t.last ? dur((Date.parse(t.last) - Date.parse(t.started_at)) / 1000) : ""
  const indent = depth * INDENT
  return (
    <li className={cn(GRID, "relative min-h-12 items-center border-b border-border py-2 transition-colors duration-150 last:border-0 hover:bg-raised @3xl:h-8 @3xl:min-h-0 @3xl:py-0")}>
      {Array.from({ length: depth }, (_, k) => (
        <span key={k} aria-hidden className="absolute inset-y-0 w-px bg-border" style={{ left: ROW_PAD + (k + 1) * INDENT - INDENT / 2 }} />
      ))}
      <div className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: indent }}>
        {kids ? <Chevron open={open} name={t.name} onClick={onToggle} /> : <span aria-hidden className="size-5 shrink-0" />}
        <StatusIcon status={status} />
        <span
          className={cn("min-w-0 truncate", root ? "text-[13px] font-medium text-foreground" : cn("text-xs", t.muted ? "text-muted-foreground" : "text-foreground"))}
          title={t.title ?? t.thread_id}
        >
          {t.name}
        </span>
      </div>
      <span className="hidden truncate text-xs text-muted-foreground @3xl:block" title={t.model ?? undefined}>{t.model ?? ""}</span>
      <span className="hidden items-center justify-end gap-2 text-xs tabular-nums @3xl:flex">
        <ShareBar share={t.tool_calls / busiest} className="w-14" />
        <span className="w-10 text-right text-foreground">{fmt(t.tool_calls)}</span>
      </span>
      <span className="hidden text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums @3xl:block" title={`${fmt(t.input_tokens)} in, ${fmt(t.output_tokens)} out`}>
        in {compact(t.input_tokens)} · out {compact(t.output_tokens)}
      </span>
      <span className="hidden text-right text-xs text-muted-foreground tabular-nums @3xl:block">{ran}</span>
      <span className={cn("text-right text-xs whitespace-nowrap tabular-nums", status === "working" ? "text-foreground" : "text-muted-foreground")}>{since(t.last, now)}</span>
      <span className="col-span-2 mt-0.5 truncate text-xs text-muted-foreground tabular-nums @3xl:hidden" style={{ paddingLeft: indent + 46 }}>
        {t.model ? `${t.model} · ` : ""}
        <span className="text-foreground">{fmt(t.tool_calls)}</span> tool calls
      </span>
    </li>
  )
}

/** The thread tree as rows, main thread first. Each parent folds its sub-agents; past a dozen rows the rest is one tap away. */
function ThreadRows({ tree }: { tree: ThreadNode[] }) {
  const now = useNow()
  const [all, setAll] = useState(false)
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  // Scale to the busiest sub-agent so they compare with each other; the main thread usually dwarfs them and simply fills its bar.
  const busiest = Math.max(1, ...(tree.length > 1 ? tree.filter((t) => t.depth > 0) : tree).map((t) => t.tool_calls))
  const parents = new Set(tree.filter((t, i) => (tree[i + 1]?.depth ?? 0) > t.depth).map((t) => t.thread_id))
  const visible: ThreadNode[] = []
  let hidden: number | null = null
  for (const t of tree) {
    if (hidden !== null) {
      if (t.depth > hidden) continue
      hidden = null
    }
    visible.push(t)
    if (folded.has(t.thread_id) && parents.has(t.thread_id)) hidden = t.depth
  }
  const rows = all ? visible : visible.slice(0, PEEK)
  const toggle = (id: string) =>
    setFolded((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  return (
    <div className="grid min-w-0 gap-3">
      <div className="min-w-0 overflow-hidden rounded-lg border">
        <div className={cn(GRID, "hidden h-7 items-center border-b border-border text-[11px] text-muted-foreground @3xl:grid")}>
          <span style={{ paddingLeft: 46 }}>Thread</span>
          <span>Model</span>
          <span className="text-right">Tool calls</span>
          <span className="text-right">Tokens</span>
          <span className="text-right">Ran</span>
          <span className="text-right">Last</span>
        </div>
        <ul aria-label="Threads">
          {rows.map((t) => (
            <Row key={t.thread_id} t={t} now={now} busiest={busiest} kids={parents.has(t.thread_id)} open={!folded.has(t.thread_id)} onToggle={() => toggle(t.thread_id)} />
          ))}
        </ul>
      </div>
      {visible.length > PEEK ? (
        <Button variant="outline" className="h-10 w-full sm:h-8 sm:w-auto sm:justify-self-start" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${fmt(visible.length)}`}
        </Button>
      ) : null}
    </div>
  )
}

/** The Threads tab: the fork timeline on top, the tree below it. */
export function Threads({ tree, harness }: { tree: ThreadNode[]; harness: string }) {
  const subagents = tree.filter((t) => t.depth > 0).length
  const nested = tree.filter((t) => t.depth > 1).length
  return (
    <div className="@container grid min-w-0 grid-cols-1 gap-4">
      <ThreadForks tree={tree} harness={harness} />
      <p className="text-xs text-muted-foreground">
        {subagents
          ? `${fmt(tree.length - subagents)} main ${tree.length - subagents === 1 ? "thread" : "threads"} and ${fmt(subagents)} ${subagents === 1 ? "sub-agent" : "sub-agents"}${nested ? `, ${fmt(nested)} started by another sub-agent` : ""}. Bars show tool calls.`
          : tree.length === 1
            ? "One thread, no sub-agents."
            : `${fmt(tree.length)} threads, no sub-agents.`}
      </p>
      <ThreadRows tree={tree} />
    </div>
  )
}
