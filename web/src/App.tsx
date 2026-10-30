import { type ReactNode, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react"
import { AlertCircle } from "lucide-react"

import { DailyCard, HeatmapCard } from "@/components/trends"
import { ModelsCard, ToolsCard } from "@/components/breakdown"
import { ControlCenter } from "@/components/control-center"
import { Group } from "@/components/kit"
import { TodayCard } from "@/components/now"
import { SessionSheet } from "@/components/session-sheet"
import { ProjectsCard, SessionsCard } from "@/components/sessions"
import { Sidebar } from "@/components/sidebar"
import { TabBar } from "@/components/tab-bar"
import { Totals } from "@/components/totals"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ViewHeader } from "@/components/view-header"
import { runIngest, useApi, useIngestWatch } from "@/lib/api"
import { statusOf } from "@/lib/fleet"
import { type RangeSel, ALL_TIME, bounds, qs, rangeError } from "@/lib/range"
import {
  parseDaily, parseHeatmap, parseLive, parseModels, parseProjects, parseReliability, parseSessionDetail, parseSessions, parseSummary, parseToday, parseTools,
} from "@/lib/types"
import { type ViewId, VIEWS, viewFromUrl, writeViewToUrl } from "@/lib/views"

const MachineView = lazy(() => import("@/components/machine-view"))

const SESSIONS_PAGE = 50
const SESSIONS_MORE = 150

function sessionFromHash(): string | null {
  const m = location.hash.match(/^#session=(.+)$/)
  return m ? decodeURIComponent(m[1]) : null
}

function useNow(everyMs: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}

/** Every view stays mounted so its controls keep their state. Inactive ones keep their width, so charts never measure zero. */
function View({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div inert={!active} aria-hidden={!active} className={active ? "grid min-w-0 gap-5" : "invisible absolute inset-x-0 top-0 h-0 overflow-hidden"}>
      {children}
    </div>
  )
}

export default function App() {
  const [harness, setHarness] = useState<string | null>(null)
  const [range, setRange] = useState<RangeSel>(ALL_TIME)
  const [project, setProject] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [limit, setLimit] = useState(SESSIONS_PAGE)
  const [sessionId, setSessionId] = useState<string | null>(sessionFromHash)
  const [refreshKey, refresh] = useReducer((n: number) => n + 1, 0)
  const [ingesting, setIngesting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [machineError, setMachineError] = useState<string | null>(null)
  const now = useNow(5000)
  const [view, setView] = useState<ViewId>(viewFromUrl)
  const scrolls = useRef<Partial<Record<ViewId, number>>>({})

  const switchView = (next: ViewId) => {
    if (next === view) {
      scrollTo({ top: 0, behavior: "smooth" })
      return
    }
    scrolls.current[view] = scrollY
    setView(next)
  }

  useLayoutEffect(() => {
    scrollTo(0, scrolls.current[view] ?? 0)
    writeViewToUrl(view)
  }, [view])

  const badRange = rangeError(range)
  const { since, until } = bounds(range)
  const ranged = (extra: Record<string, string | number | null> = {}) => (badRange ? null : qs({ ...extra, since, until }))
  const url = (path: string, params: string | null) => (params === null ? null : path + params)

  const summary = useApi(url("/api/summary", ranged()), parseSummary, refreshKey)
  const daily = useApi("/api/daily", parseDaily, refreshKey)
  const today = useApi("/api/today", parseToday, refreshKey)
  const models = useApi(url("/api/models", ranged()), parseModels, refreshKey)
  const tools = useApi(url("/api/tools", ranged({ harness, limit: 15 })), parseTools, refreshKey)
  const projects = useApi(url("/api/projects", ranged({ harness })), parseProjects, refreshKey)
  const reliability = useApi(url("/api/reliability", ranged({ harness, limit: 50 })), parseReliability, refreshKey)
  const heatmap = useApi(url("/api/heatmap", ranged({ harness })), parseHeatmap, refreshKey)
  const sessions = useApi(url("/api/sessions", ranged({ harness, project, q: query, limit })), parseSessions, refreshKey)
  // An hour of context for the timeline. The control center keeps only what is working or idle, read per session from the server state (last event as fallback).
  const live = useApi(`/api/live${qs({ minutes: 60 })}`, parseLive, refreshKey, 20_000)
  const detail = useApi(sessionId === null ? null : `/api/session/${encodeURIComponent(sessionId)}`, parseSessionDetail)

  useIngestWatch(summary.data?.last_ingest, refresh)

  useEffect(() => {
    const follow = () => setSessionId(sessionFromHash())
    addEventListener("hashchange", follow)
    return () => removeEventListener("hashchange", follow)
  }, [])

  useEffect(() => {
    const target = sessionId === null ? location.pathname + location.search : `#session=${encodeURIComponent(sessionId)}`
    history.replaceState(null, "", target)
  }, [sessionId])

  const onSearch = useCallback((q: string) => {
    setQuery(q)
    setLimit(SESSIONS_PAGE)
  }, [])

  const onIngest = async () => {
    setIngesting(true)
    try {
      await runIngest()
      setActionError(null)
      refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setIngesting(false)
    }
  }

  const harnesses = summary.data?.harnesses.map((h) => h.harness) ?? []
  const series = harness ? [harness] : harnesses
  const loadError = [summary, daily, today, models, tools, projects, reliability, heatmap, sessions].find((s) => s.error)?.error
  const banner = badRange ?? actionError ?? loadError ?? (view === "machine" ? machineError : null)
  const stale = <T,>(s: { loading: boolean; data: T | undefined }) => s.loading && s.data !== undefined

  // Sessions still going: working or idle, never ended, for the agents in view.
  const inView = live.data?.filter((r) => !harness || r.harness === harness) ?? []
  const liveCount = inView.filter((r) => statusOf(r, now) !== "ended").length
  const working = inView.filter((r) => statusOf(r, now) === "working").length
  const pickHarness = (h: string | null) => {
    setHarness(h)
    setProject(null)
  }
  const views: Record<ViewId, ReactNode> = {
    now: (
      <ControlCenter
        live={live}
        harness={harness}
        harnesses={harnesses}
        onPickHarness={pickHarness}
        today={today}
        daily={daily}
        now={now}
        onOpen={setSessionId}
        refreshKey={refreshKey}
      />
    ),
    trends: (
      <>
        <Group title="Overview" note="Always shows every agent.">
          <Totals summary={summary.data} daily={daily} range={range} stale={stale(summary)} />
        </Group>
        <TodayCard today={today} series={series} onOpen={setSessionId} />
        <div className="grid gap-5 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
          <DailyCard daily={daily} series={series} />
          <HeatmapCard heatmap={heatmap} harness={harness} />
        </div>
      </>
    ),
    usage: (
      <>
        <ToolsCard tools={tools} reliability={reliability} />
        <ModelsCard models={models} harness={harness} />
      </>
    ),
    sessions: (
      <>
        <ProjectsCard
          projects={projects}
          onPick={(p) => {
            setProject(p)
            setLimit(SESSIONS_PAGE)
            document.getElementById("recent-sessions")?.scrollIntoView({ behavior: "smooth", block: "start" })
          }}
        />
        <div id="recent-sessions" className="scroll-mt-[calc(env(safe-area-inset-top)+4.5rem)]">
          <SessionsCard
            sessions={sessions}
            query={query}
            project={project}
            limit={limit}
            onSearch={onSearch}
            onClearProject={() => setProject(null)}
            onMore={() => setLimit((n) => n + SESSIONS_MORE)}
            onOpen={setSessionId}
          />
        </div>
      </>
    ),
    // Mounted only while open, so its 15 s polling never runs behind another view.
    machine:
      view === "machine" ? (
        <Suspense fallback={<Skeleton className="h-80 rounded-lg" />}>
          <MachineView onError={setMachineError} />
        </Suspense>
      ) : null,
  }

  const setRangeAndReset = (r: RangeSel) => {
    setRange(r)
    setLimit(SESSIONS_PAGE)
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="min-h-dvh lg:grid lg:grid-cols-[232px_minmax(0,1fr)]">
        <Sidebar
          view={view}
          onView={switchView}
          live={liveCount}
          working={working}
          summary={summary.data}
          ingesting={ingesting}
          onIngest={onIngest}
          harnesses={harnesses}
          harness={harness}
          onHarness={pickHarness}
          range={range}
          onRange={setRangeAndReset}
        />
        <div className="min-w-0">
          <ViewHeader
            view={view}
            working={working}
            summary={summary.data}
            ingesting={ingesting}
            onIngest={onIngest}
            harnesses={harnesses}
            harness={harness}
            onHarness={pickHarness}
            range={range}
            onRange={setRangeAndReset}
          />
          <main className="relative grid min-w-0 gap-5 pt-4 pr-[max(1rem,env(safe-area-inset-right))] pb-[calc(env(safe-area-inset-bottom)+6rem)] pl-[max(1rem,env(safe-area-inset-left))] sm:px-6 lg:py-5 lg:pb-8">
            {banner ? (
              <Alert variant="destructive" className="rounded-lg bg-card">
                <AlertCircle aria-hidden />
                <AlertTitle>{badRange ? "Invalid date range" : actionError ? "Refresh failed" : "Couldn't load data"}</AlertTitle>
                <AlertDescription>{banner}</AlertDescription>
              </Alert>
            ) : null}
            {VIEWS.map((v) => (
              <View key={v.id} active={view === v.id}>
                {views[v.id]}
              </View>
            ))}
          </main>
        </div>
        <TabBar view={view} onView={switchView} live={liveCount} />
        <SessionSheet id={sessionId} detail={detail} onClose={() => setSessionId(null)} />
      </div>
    </TooltipProvider>
  )
}
