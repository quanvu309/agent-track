import { type ReactNode, useState } from "react"
import { Check, Copy, X } from "lucide-react"
import { cn } from "cn"

import { HarnessDot } from "@/components/kit"
import { ActivityChart } from "@/components/session-activity"
import { ThreadForks } from "@/components/session-forks"
import { Threads } from "@/components/session-threads"
import { Timeline } from "@/components/session-timeline"
import { ModelBars, ToolBars } from "@/components/session-usage"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusIcon } from "@/components/status-icon"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { Loaded } from "@/lib/api"
import { compact, dur, fmt, when } from "@/lib/format"
import { STATUS, statusOf } from "@/lib/fleet"
import { harnessMeta } from "@/lib/harness"
import { since } from "@/lib/now-time"
import { useNow } from "@/lib/session-now"
import { type ThreadNode, projectTail, threadTree } from "@/lib/session-format"
import { displayTitle } from "@/lib/session-title"
import type { SessionDetail } from "@/lib/types"

const TAB =
  "h-full gap-1.5 rounded-md px-3 text-xs data-[state=active]:border-border data-[state=active]:bg-card data-[state=active]:text-foreground group-data-[variant=default]/tabs-list:data-[state=active]:shadow-none dark:data-[state=active]:border-border dark:data-[state=active]:bg-card"

function Block({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid min-w-0 grid-cols-1 content-start gap-2.5">
      <header className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-[13px] font-semibold tracking-[-0.01em]">{title}</h3>
        {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      </header>
      {children}
    </section>
  )
}

function Figure({ label, value, exact }: { label: string; value: string; exact?: number }) {
  return (
    <div className="grid min-w-0 gap-0.5 px-2 py-2 sm:px-3">
      <dt className="truncate text-[11px] text-muted-foreground">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums" title={exact === undefined ? undefined : fmt(exact)}>{value}</dd>
    </div>
  )
}

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id)
    } catch {
      // Plain http over the LAN has no clipboard API, so fall back to a selection copy.
      const el = Object.assign(document.createElement("textarea"), { value: id })
      document.body.append(el)
      el.select()
      document.execCommand("copy")
      el.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-0.5">
      <span className="truncate font-mono text-[11px] text-muted-foreground" title={id}>{id}</span>
      <Button variant="ghost" size="icon" className="-my-1.5 size-8 shrink-0 text-muted-foreground hover:text-foreground sm:size-6" onClick={copy} aria-label={copied ? "Session id copied" : "Copy session id"}>
        {copied ? <Check aria-hidden className="size-3" /> : <Copy aria-hidden className="size-3" />}
      </Button>
      <span aria-live="polite" className="sr-only">{copied ? "Copied" : ""}</span>
    </span>
  )
}

function Overview({ d, tree }: { d: SessionDetail; tree: ThreadNode[] }) {
  const m = d.session
  const title = displayTitle(m.title)
  return (
    <div className="grid min-w-0 grid-cols-1 gap-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Block title="Tokens by model">
          {d.models.length ? <ModelBars models={d.models} harness={m.harness} /> : <p className="text-xs text-muted-foreground">No usage recorded</p>}
        </Block>
        <Block title="Tool calls by tool">
          {d.tools.length ? <ToolBars tools={d.tools} harness={m.harness} /> : <p className="text-xs text-muted-foreground">No tool calls</p>}
        </Block>
      </div>
      {tree.length > 1 ? (
        <Block title="Threads" note={`${fmt(tree.length)} in this session`}>
          <ThreadForks tree={tree} harness={m.harness} />
        </Block>
      ) : null}
      {m.title && (m.title.trim() !== title.text || title.text.length > 80) ? (
        <Block title="Title as recorded">
          <p className="max-h-48 overflow-y-auto rounded-md border bg-muted p-3 font-mono text-xs break-words whitespace-pre-wrap">{m.title}</p>
        </Block>
      ) : null}
    </div>
  )
}

function Detail({ d }: { d: SessionDetail }) {
  const m = d.session
  const tree = threadTree(d.threads, m.session_id)
  const names = new Map(tree.map((t) => [t.thread_id, t.name]))
  const threadName = (id: string) => names.get(id) ?? id
  const newestFirst = [...d.events].reverse()
  const total = m.prompts + m.tool_calls + d.models.reduce((a, r) => a + r.responses, 0)
  const tabs = [["overview", "Overview", null], ["timeline", "Timeline", d.events.length], ["threads", "Threads", d.threads.length]] as const
  const span = m.first && m.last ? (Date.parse(m.last) - Date.parse(m.first)) / 1000 : 0
  return (
    <div className="grid min-w-0 grid-cols-1 gap-5">
      <dl className="grid grid-cols-5 divide-x divide-border overflow-hidden rounded-lg border">
        <Figure label="Input" value={compact(m.input_tokens)} exact={m.input_tokens} />
        <Figure label="Cached" value={compact(m.cached_tokens)} exact={m.cached_tokens} />
        <Figure label="Output" value={compact(m.output_tokens)} exact={m.output_tokens} />
        <Figure label="Prompts" value={fmt(m.prompts)} />
        <Figure label="Tool calls" value={fmt(m.tool_calls)} />
      </dl>
      <Block title="Activity">
        <ActivityChart events={d.events} harness={m.harness} total={Math.max(total, d.events.length)} sessionSeconds={span} />
      </Block>
      <Tabs defaultValue="overview" className="min-w-0 gap-4">
        <div className="sticky -top-4 z-20 -mx-4 bg-card px-4 py-2 sm:-mx-5 sm:px-5">
          <TabsList className="h-9 w-full p-0.5 sm:h-7 sm:w-auto">
            {tabs.map(([value, label, count]) => (
              <TabsTrigger key={value} value={value} className={TAB}>
                {label}
                {count === null ? null : <span className="text-[11px] text-muted-foreground tabular-nums">{fmt(count)}</span>}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="overview" className="min-w-0">
          <Overview d={d} tree={tree} />
        </TabsContent>
        <TabsContent value="timeline" className="min-w-0">
          <Timeline events={newestFirst} threadName={threadName} />
        </TabsContent>
        <TabsContent value="threads" className="min-w-0">
          <Threads tree={tree} harness={m.harness} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** A command-only title like "poteto-mode" reads better as the first prompt it opened with, when that prompt is in the loaded events. */
function sheetTitle(d: SessionDetail) {
  const recorded = displayTitle(d.session.title)
  if (!recorded.muted) return recorded
  const first = d.events.find((e) => e.kind === "prompt" && e.text && (e.ts === d.session.started || e.ts === d.session.first))
  const prompt = first?.text ? displayTitle(first.text) : null
  return prompt && !prompt.muted ? prompt : recorded
}

const chip = "inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md bg-secondary px-1.5 py-0.5 text-xs whitespace-nowrap text-foreground"

function Chips({ m, now }: { m: SessionDetail["session"]; now: number }) {
  const status = statusOf(m, now)
  const models = (m.models ?? "").split(",").map((x) => x.trim()).filter(Boolean)
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={chip} title={STATUS[status].hint}>
        <StatusIcon status={status} size={12} label={false} />
        {STATUS[status].label}
        <span className="text-muted-foreground tabular-nums" title={m.last ? new Date(m.last).toLocaleString("en-GB") : undefined}>· {since(m.last, now)}</span>
      </span>
      <span className={chip}>
        <HarnessDot id={m.harness} className="size-2" />
        {harnessMeta(m.harness).label}
      </span>
      <span className={cn(chip, "truncate")} title={m.project ?? "No project"}>
        <span className="truncate">{projectTail(m.project)}</span>
      </span>
      {models.length ? (
        <span className={cn(chip, "truncate")} title={models.join(", ")}>
          <span className="truncate">{models.slice(0, 2).join(", ")}</span>
          {models.length > 2 ? <span className="text-muted-foreground tabular-nums">+{models.length - 2}</span> : null}
        </span>
      ) : null}
      <span className={cn(chip, "tabular-nums")}>Started {when(m.started)}</span>
      <span className={cn(chip, "tabular-nums")}>Active {dur(m.active_s)}</span>
      <CopyId id={m.session_id} />
    </div>
  )
}

export function SessionSheet({ id, detail, onClose }: { id: string | null; detail: Loaded<SessionDetail>; onClose: () => void }) {
  const now = useNow()
  const current = detail.data && detail.data.session.session_id === id ? detail.data : undefined
  const m = current?.session
  const title = current ? sheetTitle(current) : null
  return (
    <Sheet open={id !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="h-dvh w-full gap-0 bg-card p-0 sm:max-w-[min(1000px,94vw)]"
        aria-describedby={undefined}
      >
        <SheetHeader className="gap-2.5 border-b bg-card pt-[max(1rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-3 pl-[max(1rem,env(safe-area-inset-left))] sm:px-5">
          <div className="flex items-start justify-between gap-3">
            <SheetTitle className={cn("line-clamp-2 min-w-0 text-base leading-snug font-semibold tracking-[-0.01em] break-words", title?.muted && "font-medium text-muted-foreground")} title={m?.title ?? undefined}>
              {title ? title.text : "Session"}
            </SheetTitle>
            <Button variant="ghost" size="icon" className="-mt-1 -mr-1.5 size-10 shrink-0 text-muted-foreground hover:text-foreground sm:size-8" onClick={onClose} aria-label="Close">
              <X aria-hidden className="size-4" />
            </Button>
          </div>
          <div className="hidden sm:block">{m ? <Chips m={m} now={now} /> : <Skeleton className="h-5 w-2/3" />}</div>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-4 pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1.5rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] sm:px-5">
          {detail.error && !current ? (
            <Alert variant="destructive">
              <AlertTitle>Couldn't load session</AlertTitle>
              <AlertDescription>{detail.error}</AlertDescription>
            </Alert>
          ) : current ? (
            <>
              <div className="mb-4 sm:hidden">{m ? <Chips m={m} now={now} /> : null}</div>
              <Detail key={current.session.session_id} d={current} />
            </>
          ) : (
            <div className="grid min-w-0 grid-cols-1 gap-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
