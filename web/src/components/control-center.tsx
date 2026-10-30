import { useMemo } from "react"
import { ChevronRight } from "lucide-react"
import { cn } from "cn"

import { type Loaded, useApi } from "@/lib/api"
import { KanbanView } from "@/components/control-center-kanban"
import { ListView } from "@/components/control-center-list"
import { BoardSkeleton } from "@/components/control-center-parts"
import { useStored } from "@/components/control-center-stored"
import { TimelinePanel } from "@/components/control-center-timeline"
import { GROUPS, Toolbar, VIEWS } from "@/components/control-center-toolbar"
import { HarnessDot } from "@/components/kit"
import { StatusIcon } from "@/components/status-icon"
import { Skeleton } from "@/components/ui/skeleton"
import { boardSession, groupBy, harnessActivity, statusOf, todayFigures } from "@/lib/fleet"
import { compact, fmt } from "@/lib/format"
import { harnessMeta } from "@/lib/harness"
import { since } from "@/lib/now-time"
import { displayTitle } from "@/lib/session-title"
import { projectNames } from "@/lib/session-format"
import { type DailyRow, type LiveRow, type Today, parseSessions } from "@/lib/types"

export type ControlCenterProps = {
  /** `/api/live?minutes=60`: every session with an event in the last hour, each with its `thread_rows`. The control center keeps the working and idle ones. Polled every 20 s. */
  live: Loaded<LiveRow[]>
  /** The global agent filter. `harnesses` is every agent the store knows. */
  harness: string | null
  harnesses: string[]
  onPickHarness: (h: string | null) => void
  today: Loaded<Today>
  daily: Loaded<DailyRow[]>
  /** Ticks every 5 s. Every "ago" and status reads from it. */
  now: number
  onOpen: (sessionId: string) => void
  /** Bumps when the app refreshes, for the view's own requests. */
  refreshKey: number
}

const EMPTY: LiveRow[] = []

export function ControlCenter({ live, harness, harnesses, onPickHarness, today, daily, now, onOpen }: ControlCenterProps) {
  const all = live.data ?? EMPTY
  const rows = useMemo(() => all.filter((r) => (!harness || r.harness === harness) && statusOf(r, now) !== "ended"), [all, harness, now])
  const [view, setView] = useStored("cc.view", VIEWS, "list")
  const [by, setBy] = useStored("cc.group", GROUPS, "status")
  const [timeline, setTimeline] = useStored("cc.timeline", ["open", "closed"] as const, "open")
  const sessions = useMemo(() => rows.map((r) => boardSession(r, now)), [rows, now])
  const activity = useMemo(() => harnessActivity(all, now), [all, now])
  const names = useMemo(() => projectNames(rows.map((r) => r.project)), [rows])
  const groups = useMemo(() => groupBy(sessions, by, names), [sessions, by, names])
  const byStatus = useMemo(() => groupBy(sessions, "status", names), [sessions, names])
  const loading = live.data === undefined && live.error === null
  const failed = live.data === undefined ? live.error : null
  const stale = live.data !== undefined && live.error !== null

  return (
    <div className="grid min-w-0 gap-5">
      <StatusStrip
        harnesses={harnesses}
        picked={harness}
        onPick={onPickHarness}
        activity={activity}
        loading={live.data === undefined}
        today={today}
        daily={daily}
        inView={harness ? [harness] : harnesses}
      />
      {stale ? <p role="status" className="-mt-2 text-xs text-destructive">Couldn't refresh, showing older data</p> : null}
      <Toolbar count={sessions.length} loading={loading} view={view} onView={setView} group={by} onGroup={setBy} />
      {loading || failed || sessions.length === 0 || view === "list" ? (
        <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
          {loading ? (
            <BoardSkeleton />
          ) : failed ? (
            <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">Couldn't load sessions: {failed}</p>
          ) : sessions.length === 0 ? (
            <NothingRunning all={all} now={now} onOpen={onOpen} />
          ) : (
            <ListView groups={groups} now={now} onOpen={onOpen} names={names} />
          )}
        </div>
      ) : (
        <KanbanView groups={groups} now={now} onOpen={onOpen} names={names} />
      )}
      <TimelinePanel
        groups={byStatus}
        now={now}
        onOpen={onOpen}
        names={names}
        loading={loading}
        failed={failed}
        open={timeline === "open"}
        onToggle={() => setTimeline(timeline === "open" ? "closed" : "open")}
      />
    </div>
  )
}

function StatusStrip({ harnesses, picked, onPick, activity, loading, today, daily, inView }: {
  harnesses: string[]
  picked: string | null
  onPick: (h: string | null) => void
  activity: ReturnType<typeof harnessActivity>
  loading: boolean
  today: Loaded<Today>
  daily: Loaded<DailyRow[]>
  inView: string[]
}) {
  const figures = today.data && daily.data ? todayFigures(today.data, daily.data, inView) : null
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div role="group" aria-label="Show one agent" className="flex flex-wrap gap-2">
        {harnesses.map((h) => {
          const on = picked === h
          const a = activity[h]
          return (
            <button
              key={h}
              type="button"
              aria-pressed={on}
              title={on ? "Show every agent" : `Show only ${harnessMeta(h).label}`}
              onClick={() => onPick(on ? null : h)}
              className={cn(
                "inline-flex h-9 lg:h-8 items-center gap-2 rounded-md border px-2.5 text-[13px] transition-colors duration-150 ease-out disabled:pointer-events-none disabled:opacity-50",
                on ? "border-border-strong bg-raised" : "border-border hover:bg-raised",
                picked !== null && !on && "text-muted-foreground",
              )}
            >
              <HarnessDot id={h} />
              <span className="font-medium">{harnessMeta(h).label}</span>
              <span aria-live="polite" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
                {loading ? (
                  <Skeleton className="h-3 w-10" />
                ) : a?.working || a?.waiting ? (
                  <>
                    {a.working ? <span className="inline-flex items-center gap-1.5 text-foreground"><StatusIcon status="working" size={10} label={false} />{fmt(a.working)} working</span> : null}
                    {a.waiting ? <span>{fmt(a.waiting)} idle</span> : null}
                  </>
                ) : (
                  "none"
                )}
              </span>
            </button>
          )
        })}
      </div>
      {figures ? (
        <p className="text-[13px] text-muted-foreground tabular-nums">
          <Figure value={fmt(figures.sessions)} label="sessions today" />
          <Sep />
          <Figure value={fmt(figures.toolCalls)} label="tool calls today" />
          <Sep />
          <Figure value={compact(figures.outputTokens)} label="output tokens today" />
        </p>
      ) : (
        <Skeleton className="h-4 w-80 max-w-full" />
      )}
    </div>
  )
}

const Figure = ({ value, label }: { value: string; label: string }) => (
  <span><span className="font-medium text-foreground">{value}</span> {label}</span>
)
const Sep = () => <span aria-hidden className="px-2">·</span>

/** Nothing is working or idle: say so, and offer the last session to end. */
function NothingRunning({ all, now, onOpen }: { all: LiveRow[]; now: number; onOpen: (sessionId: string) => void }) {
  const newest = all.reduce<LiveRow | undefined>((a, r) => (!a || (r.last ?? "") > (a.last ?? "") ? r : a), undefined)
  const fallback = useApi(newest ? null : "/api/sessions?limit=1", parseSessions)
  const last = newest ?? fallback.data?.[0]
  return (
    <div className="flex min-h-24 flex-col justify-center">
      <p className="px-4 pt-4 pb-2 text-[13px] text-muted-foreground">Nothing is running.</p>
      {last ? (
        <button
          type="button"
          onClick={() => onOpen(last.session_id)}
          className="flex h-9 w-full items-center gap-2 border-t border-border px-4 text-left text-[13px] transition-colors duration-150 ease-out hover:bg-raised disabled:pointer-events-none disabled:opacity-50"
        >
          <span className="shrink-0 text-muted-foreground">The last session ended {since(last.last, now)}:</span>
          <span className="min-w-0 truncate font-medium">{displayTitle(last.title).text}</span>
          <ChevronRight aria-hidden className="ml-auto size-4 shrink-0 text-muted-foreground" />
        </button>
      ) : null}
    </div>
  )
}
