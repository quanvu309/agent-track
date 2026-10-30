import { useState } from "react"
import { MessageSquare, Sparkles, Wrench } from "lucide-react"
import { cn } from "cn"

import { Segmented } from "@/components/kit"
import { compact, fmt, fmtMs, whenSec } from "@/lib/format"
import { displayTitle } from "@/lib/session-title"
import type { EventRow } from "@/lib/types"

const KIND = {
  prompt: { label: "Prompt", Icon: MessageSquare },
  tool_call: { label: "Tool call", Icon: Wrench },
  response: { label: "Response", Icon: Sparkles },
} as const satisfies Record<EventRow["kind"], { label: string; Icon: typeof Wrench }>

const FILTERS = {
  all: { label: "All", keep: () => true },
  prompt: { label: "Prompts", keep: (e: EventRow) => e.kind === "prompt" },
} as const
type Filter = keyof typeof FILTERS

const GRID = "grid grid-cols-[auto_14px_minmax(0,1fr)_auto] gap-x-2.5 px-3 @2xl:grid-cols-[56px_14px_minmax(0,1fr)_150px_64px_120px] @2xl:gap-x-3"

/** A prompt shown as readable text, with the exact original one tap away. */
export function PromptText({ raw }: { raw: string }) {
  const [open, setOpen] = useState(false)
  const clean = displayTitle(raw, "Empty prompt")
  const expandable = raw.length - clean.text.length > 12 || clean.text.length > 160
  return (
    <div className="grid min-w-0 justify-items-start gap-0.5">
      {open ? (
        <p className="max-h-80 w-full overflow-y-auto rounded-md bg-muted p-2 font-mono text-xs break-words whitespace-pre-wrap">{raw}</p>
      ) : (
        <p className={cn("line-clamp-3 text-xs break-words", clean.muted ? "text-muted-foreground" : "text-foreground")}>{clean.text}</p>
      )}
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation()
            setOpen((v) => !v)
          }}
          className="-mx-1 rounded-md px-1 py-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground hover:underline focus-visible:outline-2"
        >
          {open ? "Show less" : "Show original"}
        </button>
      ) : null}
    </div>
  )
}

function Chip({ children, title }: { children: string; title?: string }) {
  return (
    <span className="inline-flex max-w-full items-center truncate rounded-md bg-secondary px-1.5 py-0.5 text-xs text-foreground" title={title ?? children}>
      {children}
    </span>
  )
}

function Tokens({ e }: { e: EventRow }) {
  if (e.input_tokens == null && e.output_tokens == null) return null
  return (
    <span title={`${fmt(e.input_tokens ?? 0)} in, ${fmt(e.output_tokens ?? 0)} out`}>
      in {compact(e.input_tokens ?? 0)} · out {compact(e.output_tokens ?? 0)}
    </span>
  )
}

function EventItem({ e, thread }: { e: EventRow; thread: string }) {
  const { label, Icon } = KIND[e.kind]
  const detail = e.tool || e.model || ""
  return (
    <li className={cn(GRID, "items-start border-b border-border py-2 text-xs transition-colors duration-150 last:border-0 hover:bg-raised")}>
      <span className="pt-0.5 text-muted-foreground tabular-nums">{whenSec(e.ts)}</span>
      <span className="pt-0.5 text-muted-foreground" title={label}>
        <Icon aria-hidden className="size-3.5" strokeWidth={1.75} />
        <span className="sr-only">{label}</span>
      </span>
      <div className="grid min-w-0 justify-items-start gap-1">
        {detail ? <Chip>{detail}</Chip> : null}
        {e.text ? <PromptText raw={e.text} /> : null}
      </div>
      <span className="hidden truncate pt-0.5 text-muted-foreground @2xl:block" title={thread}>{thread}</span>
      <span className="pt-0.5 text-right whitespace-nowrap text-muted-foreground tabular-nums">{fmtMs(e.duration_ms)}</span>
      <span className="hidden pt-0.5 text-right whitespace-nowrap text-muted-foreground tabular-nums @2xl:block"><Tokens e={e} /></span>
      <span className="col-span-2 col-start-3 flex min-w-0 flex-wrap gap-x-2 text-muted-foreground tabular-nums @2xl:hidden">
        <span className="truncate">{thread}</span>
        <Tokens e={e} />
      </span>
    </li>
  )
}

/** Events newest first, filterable to prompts. */
export function Timeline({ events, threadName }: { events: EventRow[]; threadName: (id: string) => string }) {
  const [filter, setFilter] = useState<Filter>("all")
  const counts = Object.fromEntries((Object.keys(FILTERS) as Filter[]).map((f) => [f, events.filter(FILTERS[f].keep).length])) as Record<Filter, number>
  const options = (Object.keys(FILTERS) as Filter[])
    .filter((f) => f === "all" || counts[f] > 0)
    .map((f) => [f, <>{FILTERS[f].label} <span className="tabular-nums opacity-70">{fmt(counts[f])}</span></>] as const)
  const active = counts[filter] > 0 ? filter : "all"
  const rows = events.filter(FILTERS[active].keep)
  return (
    <div className="@container grid min-w-0 grid-cols-1 gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Latest {fmt(events.length)} events, newest first</p>
        {options.length > 1 ? <Segmented label="Show events" value={active} onChange={setFilter} options={options} /> : null}
      </div>
      <div className="min-w-0 overflow-hidden rounded-lg border">
        <div className={cn(GRID, "hidden h-7 items-center border-b border-border text-[11px] text-muted-foreground @2xl:grid")}>
          <span>Time</span>
          <span />
          <span>Event</span>
          <span>Thread</span>
          <span className="text-right">Duration</span>
          <span className="text-right">Tokens</span>
        </div>
        <ol aria-label="Timeline, newest first">
          {rows.map((e, i) => (
            <EventItem key={i} e={e} thread={threadName(e.thread_id)} />
          ))}
        </ol>
      </div>
    </div>
  )
}
