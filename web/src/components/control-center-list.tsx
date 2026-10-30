import { type KeyboardEvent, type MouseEvent, type ReactNode, useRef, useState } from "react"
import { ChevronRight, Folder, Wrench } from "lucide-react"
import { cn } from "cn"

import { Collapse, Labels, ModelAvatar, SubChip } from "@/components/control-center-parts"
import { HarnessDot } from "@/components/kit"
import { StatusIcon } from "@/components/status-icon"
import { type BoardSession, type BoardThread, type Group, STATUS, threadRan } from "@/lib/fleet"
import { dur, fmt } from "@/lib/format"
import { harnessMeta } from "@/lib/harness"
import { since } from "@/lib/now-time"
import { displayTitle } from "@/lib/session-title"
import { useMedia } from "@/lib/use-media"

const GROUP_CAP = 12
const SUB_INDENT = 24

type Meta = { kind: "group" | "session" | "thread"; sessionId: string; expandable?: boolean; groupKey: string }

export type ListProps = {
  groups: Group[]
  now: number
  onOpen: (sessionId: string) => void
  names: (project: string | null) => string
}

const toggled = <T,>(set: ReadonlySet<T>, v: T): Set<T> => {
  const next = new Set(set)
  if (!next.delete(v)) next.add(v)
  return next
}

export function ListView({ groups, now, onOpen, names }: ListProps) {
  const phone = !useMedia("(min-width: 768px)")
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const [full, setFull] = useState<ReadonlySet<string>>(new Set())
  const [focusKey, setFocusKey] = useState("")
  const listRef = useRef<HTMLDivElement>(null)

  const recentLive = groups.find((g) => g.status === "waiting")?.sessions[0]
  const shown = groups
    .filter((g) => g.sessions.length > 0 || g.status === "working")
    .map((g) => {
      const empty = g.sessions.length === 0
      const capped = full.has(g.key) ? g.sessions : g.sessions.slice(0, GROUP_CAP)
      return { group: g, empty, open: !folded.has(g.key), sessions: empty && recentLive ? [recentLive] : capped }
    })

  // Everything that can hold focus, in screen order, with what each key does. The roving tabindex and the arrow keys both read it.
  const items: { key: string; meta: Meta }[] = []
  for (const { group, open, sessions } of shown) {
    items.push({ key: `g:${group.key}`, meta: { kind: "group", sessionId: "", groupKey: group.key } })
    if (!open) continue
    for (const s of sessions) {
      items.push({ key: `s:${group.key}:${s.row.session_id}`, meta: { kind: "session", sessionId: s.row.session_id, expandable: s.subagents.length > 0, groupKey: group.key } })
      if (expanded.has(s.row.session_id)) {
        for (const t of s.subagents) items.push({ key: `t:${group.key}:${t.thread_id}`, meta: { kind: "thread", sessionId: s.row.session_id, groupKey: group.key } })
      }
    }
  }
  const tabKey = items.some((i) => i.key === focusKey) ? focusKey : (items[0]?.key ?? "")
  const metaOf = new Map(items.map((i) => [i.key, i.meta]))

  const focusItem = (key: string | undefined) => {
    if (!key) return
    setFocusKey(key)
    listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const key = (e.target as HTMLElement).closest<HTMLElement>("[data-key]")?.dataset.key
    const meta = key ? metaOf.get(key) : undefined
    if (!key || !meta || e.target !== e.currentTarget.querySelector(`[data-key="${CSS.escape(key)}"]`)) return
    const at = items.findIndex((i) => i.key === key)
    const flip = (open: boolean) => {
      if (meta.kind === "group") setFolded((f) => (f.has(meta.groupKey) === !open ? f : toggled(f, meta.groupKey)))
      else if (meta.expandable) setExpanded((x) => (x.has(meta.sessionId) === open ? x : toggled(x, meta.sessionId)))
    }
    switch (e.key) {
      case "ArrowDown": focusItem(items[Math.min(items.length - 1, at + 1)]?.key); break
      case "ArrowUp": focusItem(items[Math.max(0, at - 1)]?.key); break
      case "Home": focusItem(items[0]?.key); break
      case "End": focusItem(items[items.length - 1]?.key); break
      case "ArrowRight": flip(true); break
      case "ArrowLeft":
        if (meta.kind === "thread") focusItem(items.find((i) => i.meta.kind === "session" && i.meta.sessionId === meta.sessionId && i.meta.groupKey === meta.groupKey)?.key)
        else flip(false)
        break
      case "Enter":
      case " ":
        if (meta.kind === "group") return
        onOpen(meta.sessionId)
        break
      default: return
    }
    e.preventDefault()
  }

  return (
    <div ref={listRef} onKeyDown={onKeyDown} className="divide-y divide-border">
      {shown.map(({ group, empty, open, sessions }) => {
        const gKey = `g:${group.key}`
        return (
          <section key={group.key} aria-label={`${group.label}, ${group.sessions.length}`} className="divide-y divide-border">
            <button
              type="button"
              data-key={gKey}
              tabIndex={tabKey === gKey ? 0 : -1}
              aria-expanded={open}
              title={group.status ? STATUS[group.status].hint : undefined}
              onFocus={() => setFocusKey(gKey)}
              onClick={() => setFolded((f) => toggled(f, group.key))}
              className="flex h-8 w-full items-center gap-2 bg-raised/60 px-3 text-left text-xs outline-offset-[-2px] transition-colors duration-150 ease-out hover:bg-raised disabled:pointer-events-none disabled:opacity-50"
            >
              <ChevronRight aria-hidden strokeWidth={2} className={cn("size-4 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")} />
              <GroupIcon group={group} />
              <span className="font-medium text-foreground">{group.label}</span>
              <span aria-live="polite" className="text-muted-foreground tabular-nums">{fmt(group.sessions.length)}</span>
            </button>
            <Collapse open={open}>
              <ul className="divide-y divide-border">
                {empty ? <li className="flex h-9 items-center px-3 text-[13px] text-muted-foreground md:pl-[36px]">No agent is working</li> : null}
                {sessions.map((s) => (
                  <SessionItem
                    key={s.row.session_id}
                    itemKey={`s:${group.key}:${s.row.session_id}`}
                    groupKey={group.key}
                    session={s}
                    phone={phone}
                    now={now}
                    project={names(s.row.project)}
                    open={expanded.has(s.row.session_id)}
                    tabKey={tabKey}
                    onFocusKey={setFocusKey}
                    onToggle={() => setExpanded((x) => toggled(x, s.row.session_id))}
                    onOpen={onOpen}
                  />
                ))}
                {group.sessions.length > GROUP_CAP ? (
                  <li className="flex h-9 items-center px-3">
                    <button
                      type="button"
                      aria-expanded={full.has(group.key)}
                      onClick={() => setFull((f) => toggled(f, group.key))}
                      className="h-7 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors duration-150 ease-out hover:bg-raised hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                    >
                      {full.has(group.key) ? `Show the first ${GROUP_CAP}` : `Show all ${fmt(group.sessions.length)}`}
                    </button>
                  </li>
                ) : null}
              </ul>
            </Collapse>
          </section>
        )
      })}
    </div>
  )
}

export function GroupIcon({ group, size = 12 }: { group: Group; size?: number }) {
  if (group.icon === "status" && group.status) return <StatusIcon status={group.status} size={size} label={false} />
  if (group.icon === "agent" && group.harness) return <HarnessDot id={group.harness} />
  return <Folder aria-hidden strokeWidth={1.75} className="size-3.5 text-muted-foreground" />
}

const ROW = "relative w-full cursor-pointer border-0 text-left outline-offset-[-2px] transition-colors duration-150 ease-out hover:bg-raised"

function SessionItem({ itemKey, groupKey, session, phone, now, project, open, tabKey, onFocusKey, onToggle, onOpen }: {
  itemKey: string
  groupKey: string
  session: BoardSession
  phone: boolean
  now: number
  project: string
  open: boolean
  tabKey: string
  onFocusKey: (k: string) => void
  onToggle: () => void
  onOpen: (id: string) => void
}) {
  const { row } = session
  const title = displayTitle(row.title)
  const subs = session.subagents.length
  const harness = harnessMeta(row.harness).label
  const working = session.status === "working"
  const label = `${session.key}, ${title.text}, ${STATUS[session.status].label}, ${harness}, ${project}, ${session.model ?? "unknown model"}, ${subs} sub-agents, ${fmt(row.tool_calls)} tool calls, last active ${since(row.last, now)}`
  const flip = (e: MouseEvent) => {
    e.stopPropagation()
    onToggle()
  }
  return (
    <li>
      <div
        role="button"
        data-key={itemKey}
        tabIndex={tabKey === itemKey ? 0 : -1}
        aria-label={label}
        aria-expanded={subs > 0 ? open : undefined}
        title={row.title ?? undefined}
        onFocus={() => onFocusKey(itemKey)}
        onClick={() => onOpen(row.session_id)}
        className={cn(ROW, phone ? "flex items-start gap-2.5 px-3 py-2" : "flex h-9 items-center gap-2 px-3 text-[13px]")}
      >
        {phone ? (
          <>
            <span className="pt-0.5"><StatusIcon status={session.status} label={false} /></span>
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{session.key}</span>
                <span className={cn("truncate text-[13px] font-medium", title.muted && "font-normal text-muted-foreground")}>{title.text}</span>
                <SubChip session={session} max={0} className="ml-auto" />
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <HarnessDot id={row.harness} className="size-2" />
                <span className="shrink-0">{harness}</span>
                <span aria-hidden>·</span>
                <span className="truncate">{project}</span>
                <span aria-hidden>·</span>
                <span className={cn("shrink-0 tabular-nums", working && "text-foreground")}>{since(row.last, now)}</span>
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1 pt-0.5">
              {subs > 0 ? (
                <ChevronRight aria-hidden strokeWidth={2} onClick={flip} className={cn("-ml-1 size-6 shrink-0 p-1 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")} />
              ) : null}
              <ModelAvatar model={session.model} />
            </span>
          </>
        ) : (
          <>
            <span aria-hidden onClick={subs ? flip : undefined} className={cn("flex h-9 w-4 shrink-0 items-center justify-center text-muted-foreground", subs > 0 && "hover:text-foreground")}>
              {subs > 0 ? <ChevronRight strokeWidth={2} className={cn("size-4 transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")} /> : null}
            </span>
            <StatusIcon status={session.status} label={false} />
            <span className="w-16 shrink-0 truncate text-xs text-muted-foreground tabular-nums">{session.key}</span>
            <span className={cn("min-w-0 truncate font-medium", title.muted && "font-normal text-muted-foreground")}>{title.text}</span>
            <Labels session={session} project={project} className="hidden xl:flex" />
            <span className="flex-1" />
            <span className="flex w-28 shrink-0 justify-end"><SubChip session={session} /></span>
            <ModelAvatar model={session.model} />
            <span className={cn("w-20 shrink-0 text-right text-xs tabular-nums", working ? "text-foreground" : "text-muted-foreground")}>{since(row.last, now)}</span>
          </>
        )}
      </div>
      {subs > 0 ? (
        <Collapse open={open}>
          <ul className="divide-y divide-border border-t border-border">
            {session.subagents.map((t) => (
              <ThreadItem key={t.thread_id} itemKey={`t:${groupKey}:${t.thread_id}`} thread={t} sessionId={row.session_id} phone={phone} now={now} tabKey={tabKey} onFocusKey={onFocusKey} onOpen={onOpen} />
            ))}
          </ul>
        </Collapse>
      ) : null}
    </li>
  )
}

function ThreadItem({ itemKey, thread, sessionId, phone, now, tabKey, onFocusKey, onOpen }: {
  itemKey: string
  thread: BoardThread
  sessionId: string
  phone: boolean
  now: number
  tabKey: string
  onFocusKey: (k: string) => void
  onOpen: (id: string) => void
}) {
  const depth = Math.max(1, thread.depth)
  const working = thread.status === "working"
  const ran = dur(threadRan(thread))
  const left = phone ? 12 : 12 + 16 + 8
  const lines: ReactNode[] = Array.from({ length: depth }, (_, i) => (
    <span key={i} aria-hidden className="absolute inset-y-0 w-px bg-border" style={{ left: left + 7 + i * SUB_INDENT }} />
  ))
  const label = `${thread.key}, ${thread.name}, ${STATUS[thread.status].label}, ${thread.model ?? "unknown model"}, ${fmt(thread.tool_calls)} tool calls, ran ${ran}, last active ${since(thread.last, now)}`
  return (
    <li>
      <div
        role="button"
        data-key={itemKey}
        tabIndex={tabKey === itemKey ? 0 : -1}
        aria-label={label}
        title={thread.title ?? undefined}
        onFocus={() => onFocusKey(itemKey)}
        onClick={() => onOpen(sessionId)}
        className={cn(ROW, "flex h-8 items-center gap-2 pr-3 text-xs")}
        style={{ paddingLeft: left + depth * SUB_INDENT }}
      >
        {lines}
        <StatusIcon status={thread.status} size={12} label={false} className="mx-px" />
        <span className={cn("shrink-0 truncate text-muted-foreground tabular-nums", !phone && "w-[76px]")}>{thread.key}</span>
        <span className={cn("min-w-0 truncate", thread.muted && "text-muted-foreground")}>{thread.name}</span>
        <span className="flex-1" />
        {phone ? null : (
          <span className="flex w-28 shrink-0 items-center justify-end gap-1.5 text-muted-foreground tabular-nums">
            <span className="inline-flex items-center gap-1" title="Tool calls"><Wrench aria-hidden strokeWidth={1.75} className="size-3" />{fmt(thread.tool_calls)}</span>
            <span aria-hidden>·</span>
            <span title="Ran">{ran}</span>
          </span>
        )}
        <ModelAvatar model={thread.model} />
        <span className={cn("shrink-0 text-right tabular-nums", phone ? "w-[68px]" : "w-20", working ? "text-foreground" : "text-muted-foreground")}>{since(thread.last, now)}</span>
      </div>
    </li>
  )
}
