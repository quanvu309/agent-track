import { type ReactNode, useState } from "react"
import { BarChart3, Table2 } from "lucide-react"
import { cn } from "cn"

import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { HARNESS, harnessMeta } from "@/lib/harness"
import type { PanelStatus } from "@/lib/panel-status"

export function HarnessDot({ id, className }: { id: string; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2.5 shrink-0 rounded-[3px]", className)} style={{ background: harnessMeta(id).color }} />
}

export function HarnessLabel({ id }: { id: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <HarnessDot id={id} />
      {harnessMeta(id).label}
    </span>
  )
}

const ORDER: string[] = Object.keys(HARNESS)
const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length)

export function HarnessLegend({ ids }: { ids: string[] }) {
  if (ids.length < 2) return null
  ids = [...ids].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
      {ids.map((id) => (
        <li key={id}>
          <HarnessLabel id={id} />
        </li>
      ))}
    </ul>
  )
}

export function Segmented<V extends string>({
  label, options, value, onChange, className, fill,
}: { label: string; options: readonly (readonly [V, ReactNode])[]; value: V; onChange: (v: V) => void; className?: string; fill?: boolean }) {
  return (
    <ToggleGroup
      type="single"
      aria-label={label}
      spacing={1}
      value={value}
      onValueChange={(v) => {
        const picked = options.find(([o]) => o === v)
        if (picked) onChange(picked[0])
      }}
      className={cn("shrink-0 gap-0.5 rounded-md bg-muted p-0.5", fill && "flex w-full", className)}
    >
      {options.map(([v, text]) => (
        <ToggleGroupItem
          key={v}
          value={v}
          className={cn(
            "h-9 rounded-[5px] px-2.5 text-xs font-medium text-muted-foreground hover:bg-transparent hover:text-foreground sm:h-7",
            fill && "min-w-0 flex-1 px-1.5 sm:h-8 sm:px-2.5",
          )}
        >
          {text}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

/** A quiet label that groups the cards below it inside a view. */
export function Group({ title, note, children, className }: { title: string; note?: string; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn("grid min-w-0 gap-3", className)}>
      <header className="flex flex-wrap items-baseline gap-x-2 px-1">
        <h2 className="text-[13px] font-semibold tracking-[-0.01em]">{title}</h2>
        {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      </header>
      {children}
    </section>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex min-h-32 flex-1 items-center justify-center rounded-md bg-muted/50 text-xs text-muted-foreground">{children}</div>
}

type View = "chart" | "table"

/** A card with a title, an optional view switch, a controls row, and either one body or a chart/table pair. */
export function Panel({
  title, description, controls, legend, status, stale, emptyText = "No data", chart, table, children, className, skeletonHeight = 240,
}: {
  title: ReactNode
  description?: ReactNode
  controls?: ReactNode
  legend?: ReactNode
  status: PanelStatus
  stale?: boolean
  emptyText?: ReactNode
  chart?: () => ReactNode
  table?: () => ReactNode
  children?: () => ReactNode
  className?: string
  skeletonHeight?: number
}) {
  const [view, setView] = useState<View>("chart")
  const switchable = Boolean(chart && table)
  const body = status === "loading" ? (
    <Skeleton className="w-full rounded-md" style={{ height: skeletonHeight }} />
  ) : status === "empty" ? (
    <Empty>{emptyText}</Empty>
  ) : children ? (
    children()
  ) : view === "chart" && chart ? (
    chart()
  ) : (
    table?.()
  )
  return (
    <Card className={cn("min-w-0 gap-0 rounded-lg py-0", className)}>
      <CardHeader className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 pt-3 pb-2">
        <CardTitle className="text-[15px] leading-5 font-semibold tracking-[-0.01em]">{title}</CardTitle>
        {description ? <CardDescription className="min-w-0 text-xs leading-5">{description}</CardDescription> : null}
        {switchable ? (
          <CardAction className="ml-auto self-center">
            <Segmented
              label="View"
              value={view}
              onChange={setView}
              options={[
                ["chart", <><BarChart3 aria-hidden className="size-3.5" /><span className="sr-only sm:not-sr-only">Chart</span></>],
                ["table", <><Table2 aria-hidden className="size-3.5" /><span className="sr-only sm:not-sr-only">Table</span></>],
              ]}
            />
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className={cn("@container flex min-w-0 flex-1 flex-col gap-3 px-4 pb-4 transition-opacity duration-200", stale && "opacity-60")} aria-busy={stale || status === "loading"}>
        {controls || (legend && status === "ready" && view === "chart") ? (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="-mx-1 flex w-[calc(100%+0.5rem)] overflow-x-auto px-1 py-0.5 [scrollbar-width:none] sm:w-auto sm:max-w-full">{controls}</div>
            {status === "ready" && view === "chart" ? legend : null}
          </div>
        ) : null}
        {body}
      </CardContent>
    </Card>
  )
}
