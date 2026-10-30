import { useEffect, useState } from "react"
import { ChevronRight, Search, X } from "lucide-react"

import { DataTable } from "@/components/data-table"
import { HarnessDot, Panel } from "@/components/kit"
import { AgentName, LastActive, SessionTitle, ShareBar } from "@/components/session-bits"
import { SessionCards } from "@/components/session-cards"
import { LifespanBar } from "@/components/session-lifespan"
import { ProjectsTreemap } from "@/components/session-treemap"
import { StatusIcon } from "@/components/status-icon"
import { TimeTicks } from "@/components/session-viz"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { Loaded } from "@/lib/api"
import { compact, dur, fmt, pct, shortPath, when } from "@/lib/format"
import { statusOf } from "@/lib/fleet"
import { harnessMeta } from "@/lib/harness"
import { status } from "@/lib/panel-status"
import { displayTitle } from "@/lib/session-title"
import { useNow } from "@/lib/session-now"
import { projectNames, since } from "@/lib/session-format"
import { at, timeTicks } from "@/lib/session-layout"
import { lifeDomain, lifeOf, startedText } from "@/lib/session-life"
import type { ProjectRow, SessionRow } from "@/lib/types"

const ts = (s: string | null) => (s ? Date.parse(s) : null)

const PROJECTS_PEEK = 5
const PHONE_PAGE = 15

function AgentDots({ ids }: { ids: string[] }) {
  return (
    <span className="flex w-8 shrink-0 gap-1" role="img" aria-label={ids.map((h) => harnessMeta(h).label).join(", ")}>
      {ids.map((h) => <HarnessDot key={h} id={h} className="size-2" />)}
    </span>
  )
}

export function ProjectsCard({ projects, onPick }: { projects: Loaded<ProjectRow[]>; onPick: (project: string) => void }) {
  const [allShown, setAllShown] = useState(false)
  const now = useNow()
  const rows = projects.data ?? []
  const byRecent = [...rows].sort((a, b) => (ts(b.last_active) ?? 0) - (ts(a.last_active) ?? 0))
  const totalCalls = rows.reduce((a, r) => a + r.tool_calls, 0)
  const name = projectNames(rows.map((r) => r.project))
  const share = (r: ProjectRow) => (totalCalls ? r.tool_calls / totalCalls : 0)
  const phoneList = () => (
    <div className="grid md:hidden">
      <ul aria-label="Projects" className="-mx-4 divide-y divide-border border-y border-border sm:-mx-5">
        {byRecent.slice(0, allShown ? undefined : PROJECTS_PEEK).map((r) => (
          <li key={r.project}>
            <button
              type="button"
              onClick={() => onPick(r.project)}
              aria-label={`Filter sessions to ${shortPath(r.project)}`}
              className="grid min-h-14 w-full grid-cols-[minmax(0,1fr)_4.5rem_auto] items-center gap-x-3 px-4 py-2.5 text-left transition-colors duration-150 ease-out hover:bg-raised focus-visible:bg-raised active:bg-secondary"
            >
              <span className="grid min-w-0 gap-1">
                <span className="flex min-w-0 items-center gap-2">
                  <AgentDots ids={r.harnesses} />
                  <span className="truncate text-[13px] font-medium" title={r.project}>{name(r.project)}</span>
                </span>
                <span className="truncate text-xs text-muted-foreground tabular-nums">
                  {fmt(r.sessions)} {r.sessions === 1 ? "session" : "sessions"} · {since(r.last_active, now)}
                </span>
              </span>
              <span className="grid gap-1 text-right text-xs tabular-nums">
                <span className="font-medium">{pct(r.tool_calls, totalCalls)}</span>
                <ShareBar share={share(r)} />
              </span>
              <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
      {byRecent.length > PROJECTS_PEEK ? (
        <Button variant="ghost" className="mt-2 h-10 w-full text-[13px]" onClick={() => setAllShown((v) => !v)}>
          {allShown ? "Show fewer" : `Show all ${byRecent.length} projects`}
        </Button>
      ) : null}
    </div>
  )
  const desktopTable = () => (
    <div className="hidden md:block">
      <DataTable
        label="Projects"
        rows={rows}
        rowKey={(r) => r.project}
        initialSort={{ key: "last_active", dir: -1 }}
        maxHeight={340}
        onRowClick={(r) => onPick(r.project)}
        rowLabel={(r) => `Filter sessions to ${shortPath(r.project)}`}
        columns={[
          {
            key: "project", label: "Project", sortValue: (r) => r.project, className: "min-w-48 max-w-80",
            cell: (r) => (
              <span className="flex min-w-0 items-center gap-2">
                <AgentDots ids={r.harnesses} />
                <span className="truncate font-medium" title={r.project}>{name(r.project)}</span>
              </span>
            ),
          },
          { key: "sessions", label: "Sessions", num: true, cell: (r) => fmt(r.sessions), sortValue: (r) => r.sessions },
          { key: "tool_calls", label: "Tool calls", num: true, cell: (r) => fmt(r.tool_calls), sortValue: (r) => r.tool_calls },
          {
            key: "share", label: "Share", sortValue: (r) => r.tool_calls, className: "w-40",
            cell: (r) => (
              <span className="flex items-center gap-2">
                <ShareBar share={share(r)} className="w-24" />
                <span className="w-11 text-right text-muted-foreground tabular-nums">{pct(r.tool_calls, totalCalls)}</span>
              </span>
            ),
          },
          { key: "input_tokens", label: "Input", num: true, cell: (r) => <span title={fmt(r.input_tokens)}>{compact(r.input_tokens)}</span>, sortValue: (r) => r.input_tokens },
          { key: "output_tokens", label: "Output", num: true, cell: (r) => <span title={fmt(r.output_tokens)}>{compact(r.output_tokens)}</span>, sortValue: (r) => r.output_tokens },
          { key: "prompts", label: "Prompts", num: true, cell: (r) => fmt(r.prompts), sortValue: (r) => r.prompts, wideOnly: true },
          { key: "last_active", label: "Last active", cell: (r) => <LastActive row={{ last: r.last_active }} now={now} />, sortValue: (r) => ts(r.last_active) },
        ]}
      />
    </div>
  )
  return (
    <Panel
      title="Projects"
      description="Sized by tool calls. Select a project to filter sessions"
      status={status(projects.data, (d) => d.length === 0)}
      stale={projects.loading && projects.data !== undefined}
      skeletonHeight={280}
      chart={() => (
        <>
          <ProjectsTreemap rows={rows} name={name} onPick={onPick} now={now} />
          {phoneList()}
        </>
      )}
      table={() => (
        <>
          {phoneList()}
          {desktopTable()}
        </>
      )}
    />
  )
}

function SearchBox({ onSearch }: { onSearch: (q: string) => void }) {
  const [text, setText] = useState("")
  useEffect(() => {
    const timer = setTimeout(() => onSearch(text.trim()), 250)
    return () => clearTimeout(timer)
  }, [text, onSearch])
  return (
    <div className="relative w-full sm:w-64">
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Search sessions"
        aria-label="Search sessions by title, project or prompt text"
        autoComplete="off"
        className="h-10 pl-8 sm:h-8"
      />
    </div>
  )
}

export function SessionsCard({
  sessions, query, project, limit, onSearch, onClearProject, onMore, onOpen,
}: {
  sessions: Loaded<SessionRow[]>
  query: string
  project: string | null
  limit: number
  onSearch: (q: string) => void
  onClearProject: () => void
  onMore: () => void
  onOpen: (id: string) => void
}) {
  const now = useNow()
  const rows = sessions.data ?? []
  const name = projectNames(rows.map((r) => r.project))
  const [phoneShown, setPhoneShown] = useState({ key: "", n: PHONE_PAGE })
  const filterKey = `${query}|${project ?? ""}`
  const shown = phoneShown.key === filterKey ? phoneShown.n : PHONE_PAGE
  const busiest = Math.max(1, ...rows.map((r) => r.tool_calls))
  const lives = new Map(rows.map((r) => [r.session_id, lifeOf(r, now)]))
  const domain = lifeDomain([...lives.values()])
  const pos = (t: number) => (domain ? at(domain, t) : 0)
  const phoneTicks = domain ? timeTicks(domain, 3) : []
  const columnTicks = domain ? timeTicks(domain, 3) : []
  const activity = (r: SessionRow) => r.tool_calls / busiest
  const canFetchMore = rows.length >= limit
  const phoneMore = () => {
    const next = shown + PHONE_PAGE * 2
    if (next > rows.length && canFetchMore) onMore()
    setPhoneShown({ key: filterKey, n: next })
  }
  return (
    <Panel
      title="Recent sessions"
      description="Bars show when each session ran, on one shared clock"
      controls={
        <div className="flex w-full flex-wrap items-center gap-2">
          <SearchBox onSearch={onSearch} />
          {project ? (
            <Badge variant="secondary" className="h-8 gap-1 pr-1 pl-2.5 text-xs font-normal sm:h-7">
              <span className="max-w-56 truncate" title={project}>Project: {name(project)}</span>
              <Button variant="ghost" size="icon" className="size-7 rounded-full sm:size-5" onClick={onClearProject} aria-label="Remove project filter">
                <X className="size-3.5" />
              </Button>
            </Badge>
          ) : null}
        </div>
      }
      status={status(sessions.data, (d) => d.length === 0)}
      stale={sessions.loading && sessions.data !== undefined}
      emptyText={query ? "No sessions match the search" : "No sessions"}
    >
      {() => (
        <div className="grid min-w-0 grid-cols-1 gap-4">
          <div className="grid gap-1 md:hidden">
            {domain ? (
              <div className="flex gap-2 pr-7">
                <TimeTicks ticks={phoneTicks} pos={pos} className="flex-1" />
                <span className="w-12 shrink-0 text-right text-[11px] leading-4 text-muted-foreground">Started</span>
              </div>
            ) : null}
            <SessionCards
              label="Recent sessions"
              rows={rows.slice(0, shown)}
              now={now}
              project={name}
              onOpen={onOpen}
              share={(r) => ({ value: activity(r), label: <><span className="font-medium">{fmt(r.tool_calls)}</span> <span className="text-muted-foreground">tool calls</span></> })}
              figures={(r) => [
                ["", <LastActive key="last" row={r} now={now} />],
                ["Active", dur(r.active_s)],
                ["Input", compact(r.input_tokens)],
              ]}
              mark={
                domain
                  ? (r) => {
                      const life = lives.get(r.session_id) ?? null
                      return (
                        <span className="flex items-center gap-2 text-xs">
                          <LifespanBar life={life} domain={domain} ticks={phoneTicks} className="flex-1" />
                          <span className="w-12 shrink-0 text-right text-muted-foreground tabular-nums">{life ? startedText(life, now) : ""}</span>
                        </span>
                      )
                    }
                  : undefined
              }
            />
            {shown < rows.length || canFetchMore ? (
              <Button variant="outline" className="mt-2 h-10 w-full" onClick={phoneMore} disabled={sessions.loading}>
                Show more
              </Button>
            ) : null}
          </div>
          <div className="hidden md:block">
            <DataTable
              label="Recent sessions"
              rows={rows}
              rowKey={(r) => r.session_id}
              initialSort={{ key: "last", dir: -1 }}
              maxHeight={600}
              onRowClick={(r) => onOpen(r.session_id)}
              rowLabel={(r) => `Open session ${displayTitle(r.title).text}`}
              columns={[
                {
                  key: "title", label: "Session", sortValue: (r) => displayTitle(r.title).text.toLowerCase(), className: "min-w-56 max-w-[18rem]",
                  cell: (r) => (
                    <span className="flex min-w-0 items-center gap-2">
                      <StatusIcon status={statusOf(r, now)} />
                      <SessionTitle raw={r.title} className="min-w-0" />
                    </span>
                  ),
                },
                { key: "harness", label: "Agent", cell: (r) => <AgentName id={r.harness} />, sortValue: (r) => r.harness },
                { key: "project", label: "Project", cell: (r) => name(r.project), clip: (r) => r.project ?? "", sortValue: (r) => r.project, className: "max-w-44 text-muted-foreground" },
                {
                  key: "subagents", label: "Sub-agents", num: true, className: "w-24", sortValue: (r) => r.threads - 1,
                  cell: (r) => (r.threads > 1 ? fmt(r.threads - 1) : <span className="text-muted-foreground">0</span>),
                },
                { key: "models", label: "Models", cell: (r) => r.models ?? "", clip: (r) => r.models ?? "", sortValue: (r) => r.models, className: "max-w-48 text-muted-foreground", wideOnly: true },
                { key: "started", label: "Started", cell: (r) => when(r.started), sortValue: (r) => ts(r.started), className: "text-muted-foreground whitespace-nowrap", wideOnly: true },
                { key: "last", label: "Last active", cell: (r) => <LastActive row={r} now={now} />, sortValue: (r) => ts(r.last) },
                ...(domain
                  ? [{
                      key: "ran", label: "When it ran", className: "w-44 min-w-44",
                      head: <TimeTicks ticks={columnTicks} pos={pos} className="w-40" />,
                      cell: (r: SessionRow) => <LifespanBar life={lives.get(r.session_id) ?? null} domain={domain} ticks={columnTicks} className="w-40" />,
                    }]
                  : []),
                { key: "active_s", label: "Active", num: true, cell: (r) => dur(r.active_s), sortValue: (r) => r.active_s },
                { key: "input_tokens", label: "Input", num: true, cell: (r) => <span title={fmt(r.input_tokens)}>{compact(r.input_tokens)}</span>, sortValue: (r) => r.input_tokens },
                { key: "output_tokens", label: "Output", num: true, cell: (r) => <span title={fmt(r.output_tokens)}>{compact(r.output_tokens)}</span>, sortValue: (r) => r.output_tokens },
                { key: "prompts", label: "Prompts", num: true, cell: (r) => fmt(r.prompts), sortValue: (r) => r.prompts, wideOnly: true },
                {
                  key: "tool_calls", label: "Tool calls", num: true, sortValue: (r) => r.tool_calls, className: "w-32",
                  cell: (r) => (
                    <span className="flex items-center justify-end gap-2">
                      <ShareBar share={activity(r)} className="w-14" />
                      <span className="min-w-11">{fmt(r.tool_calls)}</span>
                    </span>
                  ),
                },
              ]}
            />
          </div>
          {canFetchMore ? (
            <Button variant="outline" className="hidden h-9 w-auto justify-self-start md:inline-flex" onClick={onMore} disabled={sessions.loading}>
              Show more
            </Button>
          ) : null}
        </div>
      )}
    </Panel>
  )
}
