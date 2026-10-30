import type { ReactNode } from "react"
import { ChevronRight, GitBranch } from "lucide-react"
import { cn } from "cn"

import { HarnessDot } from "@/components/kit"
import { StatusDots } from "@/components/status-icon"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { type BoardSession, modelMark, subProgress } from "@/lib/fleet"
import { harnessMeta } from "@/lib/harness"

/** A flush panel: a header with the title, a one-line description and optional controls, then a body that runs edge to edge so rows can carry their own padding. With `collapse` the title is a button that folds the body. */
export function Surface({ title, description, controls, collapse, children, className }: {
  title: string
  description?: ReactNode
  controls?: ReactNode
  collapse?: { open: boolean; onToggle: () => void }
  children: ReactNode
  className?: string
}) {
  const folded = collapse ? !collapse.open : false
  const heading = <h2 className="text-[15px] leading-5 font-semibold tracking-[-0.01em]">{title}</h2>
  return (
    <section aria-label={title} className={cn("min-w-0 rounded-lg border border-border bg-card", className)}>
      <header className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-3 pb-2.5", !folded && "border-b border-border")}>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5">
          {collapse ? (
            <button
              type="button"
              aria-expanded={collapse.open}
              onClick={collapse.onToggle}
              className="-ml-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-left transition-colors duration-150 ease-out hover:bg-raised disabled:pointer-events-none disabled:opacity-50"
            >
              <ChevronRight aria-hidden strokeWidth={2} className={cn("size-3.5 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none", collapse.open && "rotate-90")} />
              {heading}
            </button>
          ) : (
            heading
          )}
          {description ? <p className="text-xs text-muted-foreground tabular-nums">{description}</p> : null}
        </div>
        {collapse && folded ? null : controls}
      </header>
      {collapse ? <Collapse open={collapse.open}>{children}</Collapse> : children}
    </section>
  )
}

/** Height-animated disclosure. Closed content is inert, so it takes no focus and no clicks. */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      inert={!open}
      className={cn("grid transition-[grid-template-rows] duration-150 ease-out motion-reduce:transition-none", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}

export function TimelineSkeleton({ wide }: { wide: boolean }) {
  return (
    <div aria-hidden className="grid divide-y divide-transparent px-4 py-2">
      {[62, 38, 74, 24, 50].map((w, i) => (
        <div key={i} className={cn("grid items-center gap-x-3 py-2", wide && "grid-cols-[228px_minmax(0,1fr)]")}>
          <div className="grid gap-1.5 pb-1.5 sm:pb-0">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <div className="h-4">
            <Skeleton className="mt-1 h-1.5 rounded-full" style={{ width: `${w}%`, marginLeft: `${100 - w - (i % 3) * 8}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export function BoardSkeleton() {
  return (
    <div aria-hidden>
      <Skeleton className="h-8 rounded-none" />
      {[70, 55, 82, 44].map((w, i) => (
        <div key={i} className="flex h-9 items-center gap-3 border-b border-border px-4 last:border-0">
          <Skeleton className="size-3.5 rounded-full" />
          <Skeleton className="h-3.5" style={{ width: `${w}%`, maxWidth: 420 }} />
          <Skeleton className="ml-auto hidden h-3 w-40 md:block" />
        </div>
      ))}
    </div>
  )
}

/** The assignee: the model as a 16 px round avatar with a two-letter mark and the full name in a tooltip. Rows already carry the model in their accessible name, so the mark is hidden from assistive tech. */
export function ModelAvatar({ model, className }: { model: string | null; className?: string }) {
  const { mark, label } = modelMark(model)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-hidden
          className={cn("inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-[9px] leading-none font-semibold text-foreground", className)}
        >
          {mark}
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** Sub-issues chip: a branch glyph, `done/total` and one dot per sub-agent. Nothing when the session has none. */
export function SubChip({ session, max = 4, className }: { session: BoardSession; max?: number; className?: string }) {
  const { done, total } = subProgress(session)
  if (!total) return null
  return (
    <span
      title={`${done} of ${total} sub-agents ended`}
      className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded border border-border px-1.5 text-[11px] text-muted-foreground tabular-nums", className)}
    >
      <GitBranch aria-hidden strokeWidth={1.75} className="size-3.5" />
      {done}/{total}
      {max > 0 ? <StatusDots statuses={session.subStatuses} max={max} className="ml-0.5" /> : null}
    </span>
  )
}

const CHIP = "inline-flex h-5 min-w-0 shrink-0 items-center gap-1 rounded bg-secondary px-1.5 text-[11px] text-muted-foreground"

/** Labels: the project tail and the harness. */
export function Labels({ session, project, className }: { session: BoardSession; project: string; className?: string }) {
  return (
    <span className={cn("flex min-w-0 shrink-0 items-center gap-1.5", className)}>
      <span className={cn(CHIP, "max-w-[160px]")} title={session.row.project ?? undefined}><span className="truncate">{project}</span></span>
      <span className={CHIP}>
        <HarnessDot id={session.row.harness} className="size-1.5" />
        {harnessMeta(session.row.harness).label}
      </span>
    </span>
  )
}
