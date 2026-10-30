import { RefreshCw } from "lucide-react"
import { cn } from "cn"

import { StatusIcon } from "@/components/status-icon"
import type { Summary } from "@/lib/types"
import { iconButton } from "@/lib/icon-button"

export type IngestProps = { summary: Summary | undefined; ingesting: boolean; onIngest: () => void }

function ingestState(summary: Summary | undefined, ingesting: boolean): { busy: boolean; text: string } {
  const busy = ingesting || Boolean(summary?.ingesting)
  if (busy) return { busy, text: "Refreshing" }
  if (!summary) return { busy, text: "Loading" }
  if (!summary.last_ingest) return { busy, text: "No data yet" }
  return { busy, text: `Updated ${new Date(summary.last_ingest).toLocaleTimeString("en-GB", { hour12: false })}` }
}

export function IngestLine({ summary, ingesting, className }: Pick<IngestProps, "summary" | "ingesting"> & { className?: string }) {
  const { busy, text } = ingestState(summary, ingesting)
  return (
    <p className={cn("flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums", className)} aria-live="polite">
      {busy ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-working motion-safe:animate-pulse" /> : null}
      {text}
    </p>
  )
}

export function RefreshButton({ summary, ingesting, onIngest, className }: IngestProps & { className?: string }) {
  const { busy } = ingestState(summary, ingesting)
  return (
    <button type="button" onClick={onIngest} disabled={ingesting} className={cn(iconButton, className)} aria-label="Refresh" title="Refresh">
      <RefreshCw aria-hidden className={cn(busy && "motion-safe:animate-spin")} />
    </button>
  )
}
/** Shown only while an agent is working, so its presence is the signal. */
export function WorkingPill({ count, className }: { count: number; className?: string }) {
  if (count === 0) return null
  return (
    <span role="status" className={cn("inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-2 text-[11px] font-medium text-foreground tabular-nums", className)}>
      <StatusIcon status="working" size={10} label={false} />
      {count} working
    </span>
  )
}

export function LiveBadge({ count, className }: { count: number; className?: string }) {
  if (!count) return null
  return (
    <span className={cn("inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground/10 px-1.5 text-[11px] leading-none font-medium text-foreground tabular-nums", className)}>
      {count}
      <span className="sr-only"> active</span>
    </span>
  )
}
