import { cn } from "cn"

import { HarnessDot } from "@/components/kit"
import { StatusIcon } from "@/components/status-icon"
import { harnessMeta } from "@/lib/harness"
import { displayTitle } from "@/lib/session-title"
import { type StatusInput, statusOf } from "@/lib/fleet"
import { since } from "@/lib/session-format"

/** A session title made readable. The raw text stays in the title attribute. */
export function SessionTitle({ raw, className }: { raw: string | null; className?: string }) {
  const t = displayTitle(raw)
  return (
    <span title={raw ?? undefined} className={cn("truncate", t.muted ? "font-normal text-muted-foreground" : "font-medium", className)}>
      {t.text}
    </span>
  )
}

/** Relative last activity. A session working right now gets the working glyph and full ink. */
export function LastActive({ row, now }: { row: StatusInput; now: number }) {
  const ts = row.last
  const live = statusOf(row, now) === "working"
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", live ? "font-medium text-foreground" : "text-muted-foreground")} title={ts ? new Date(ts).toLocaleString("en-GB") : undefined}>
      {live ? <StatusIcon status="working" size={10} label={false} /> : null}
      {since(ts, now)}
      {live ? <span className="sr-only">, live</span> : null}
    </span>
  )
}

export function AgentName({ id }: { id: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <HarnessDot id={id} className="size-2" />
      {harnessMeta(id).label}
    </span>
  )
}

/** A thin magnitude bar. `share` is 0..1 and is drawn linearly; any non-zero value keeps a visible sliver. */
export function ShareBar({ share, className }: { share: number; className?: string }) {
  const pct = Math.max(0, Math.min(1, share)) * 100
  return (
    <span aria-hidden className={cn("block h-1 overflow-hidden rounded-full bg-muted", className)}>
      <span className="block h-full rounded-full bg-foreground/60" style={{ width: pct > 0 ? `max(2px, ${pct}%)` : 0 }} />
    </span>
  )
}
