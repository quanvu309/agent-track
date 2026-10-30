import { useState } from "react"
import { cn } from "cn"

import { ModelAvatar, SubChip } from "@/components/control-center-parts"
import { GroupIcon } from "@/components/control-center-list"
import { HarnessDot } from "@/components/kit"
import { StatusIcon } from "@/components/status-icon"
import { type BoardSession, type Group, STATUS } from "@/lib/fleet"
import { fmt } from "@/lib/format"
import { harnessMeta } from "@/lib/harness"
import { since } from "@/lib/now-time"
import { displayTitle } from "@/lib/session-title"

const COLUMN_CAP = 20

export type KanbanProps = {
  groups: Group[]
  now: number
  onOpen: (sessionId: string) => void
  names: (project: string | null) => string
}

export function KanbanView({ groups, now, onOpen, names }: KanbanProps) {
  const [full, setFull] = useState<ReadonlySet<string>>(new Set())
  // The Working column stays when empty. Waiting, agent and project columns appear only with threads in them.
  const columns = groups.filter((g) => g.sessions.length > 0 || g.status === "working")
  return (
    <div className="-mx-4 flex snap-x snap-proximity scroll-px-4 sm:scroll-px-6 items-start gap-3 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6">
      {columns.map((g) => {
        const all = full.has(g.key)
        const cards = all ? g.sessions : g.sessions.slice(0, COLUMN_CAP)
        return (
          <section key={g.key} aria-label={`${g.label}, ${g.sessions.length}`} className="w-80 shrink-0 snap-start">
            <header className="flex h-9 items-center gap-2 px-2">
              <GroupIcon group={g} size={14} />
              <h3 className="text-[13px] font-medium" title={g.status ? STATUS[g.status].hint : undefined}>{g.label}</h3>
              <span aria-live="polite" className="text-xs text-muted-foreground tabular-nums">{fmt(g.sessions.length)}</span>
            </header>
            <div className="grid max-h-[70vh] gap-2 overflow-y-auto rounded-lg bg-raised p-2">
              {cards.length ? (
                cards.map((s) => <Card key={s.row.session_id} session={s} now={now} project={names(s.row.project)} onOpen={onOpen} />)
              ) : (
                <p className="flex h-16 items-center justify-center text-xs text-muted-foreground">{g.status === "working" ? "No agent is working" : "No threads"}</p>
              )}
              {g.sessions.length > COLUMN_CAP ? (
                <button
                  type="button"
                  aria-expanded={all}
                  onClick={() => setFull((f) => { const n = new Set(f); if (!n.delete(g.key)) n.add(g.key); return n })}
                  className="h-8 rounded-md text-xs font-medium text-muted-foreground transition-colors duration-150 ease-out hover:bg-raised hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  {all ? `Show the first ${COLUMN_CAP}` : `Show ${fmt(g.sessions.length - COLUMN_CAP)} more`}
                </button>
              ) : null}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function Card({ session, now, project, onOpen }: { session: BoardSession; now: number; project: string; onOpen: (id: string) => void }) {
  const { row } = session
  const title = displayTitle(row.title)
  const harness = harnessMeta(row.harness).label
  const working = session.status === "working"
  const subs = session.subagents.length
  const label = `${session.key}, ${title.text}, ${STATUS[session.status].label}, ${harness}, ${project}, ${session.model ?? "unknown model"}, ${subs} sub-agents, last active ${since(row.last, now)}`
  return (
    <button
      type="button"
      aria-label={label}
      title={row.title ?? undefined}
      onClick={() => onOpen(row.session_id)}
      className="grid min-w-0 gap-2 rounded-md border border-border bg-card p-3 text-left transition-colors duration-150 ease-out hover:border-border-strong disabled:pointer-events-none disabled:opacity-50"
    >
      <span className="flex items-center gap-2">
        <StatusIcon status={session.status} label={false} />
        <span className="text-xs text-muted-foreground tabular-nums">{session.key}</span>
        <span className="ml-auto"><ModelAvatar model={session.model} /></span>
      </span>
      <span className={cn("line-clamp-2 text-[13px] leading-[18px] font-medium break-words", title.muted && "font-normal text-muted-foreground")}>{title.text}</span>
      <span className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
        <HarnessDot id={row.harness} className="size-2" />
        <span className="min-w-0 truncate">{project}</span>
        <span className="flex-1" />
        <SubChip session={session} max={3} />
        <span className={cn("shrink-0 tabular-nums", working && "text-foreground")}>{since(row.last, now)}</span>
      </span>
    </button>
  )
}
