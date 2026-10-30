import { SlidersHorizontal } from "lucide-react"
import { cn } from "cn"

import { HarnessDot, Segmented } from "@/components/kit"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { harnessMeta } from "@/lib/harness"
import { iconButton } from "@/lib/icon-button"
import { type RangeSel, ALL_TIME, bounds, custom, lastDays, rangeText } from "@/lib/range"
import { WIDE, useMedia } from "@/lib/use-media"

export type FilterProps = {
  harnesses: string[]
  harness: string | null
  onHarness: (h: string | null) => void
  range: RangeSel
  onRange: (r: RangeSel) => void
}

const PRESETS = [
  ["all", "All time"],
  ["7", "7 days"],
  ["30", "30 days"],
] as const

function Filters({ harnesses, harness, onHarness, range, onRange }: FilterProps) {
  const { since, until } = bounds(range)
  const preset = range.kind === "all" ? "all" : range.kind === "last" ? String(range.days) : ""
  const label = "text-xs font-medium text-muted-foreground"
  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <span className={label}>Agent</span>
        <Segmented
          label="Agent filter"
          fill
          value={harness ?? "all"}
          onChange={(v) => onHarness(v === "all" ? null : v)}
          options={[
            ["all", "All"],
            ...harnesses.map((h) => [h, <><HarnessDot id={h} className="size-2" />{harnessMeta(h).label}</>] as const),
          ]}
        />
      </div>
      <div className="grid gap-2">
        <span className={label}>Dates</span>
        <Segmented
          label="Date range preset"
          fill
          value={preset as "all" | "7" | "30"}
          onChange={(v) => onRange(v === "all" ? ALL_TIME : lastDays(v === "7" ? 7 : 30))}
          options={PRESETS}
        />
        <div className="mt-1 grid grid-cols-2 gap-3">
          <label className="grid gap-1.5 text-xs text-muted-foreground">
            From
            <Input type="date" className="h-11 min-w-0 px-2 text-base text-foreground lg:h-9 lg:text-[13px]" value={since} max={until || undefined} onChange={(e) => onRange(custom(e.target.value, until))} />
          </label>
          <label className="grid gap-1.5 text-xs text-muted-foreground">
            To
            <Input type="date" className="h-11 min-w-0 px-2 text-base text-foreground lg:h-9 lg:text-[13px]" value={until} min={since || undefined} onChange={(e) => onRange(custom(since, e.target.value))} />
          </label>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">The control center and the daily chart ignore the dates. Overview ignores the agent. Machine ignores both.</p>
    </div>
  )
}

/** `chip` shows the active filters as text (desktop header). `icon` is a square button that marks active filters with a dot. */
export function FilterSheet({ trigger, className, ...filters }: FilterProps & { trigger: "chip" | "icon"; className?: string }) {
  const wide = useMedia(WIDE)
  const filtered = filters.harness !== null || filters.range.kind !== "all"
  const summary = `${filters.harness ? harnessMeta(filters.harness).label : "All agents"} · ${rangeText(filters.range)}`
  return (
    <Sheet>
      <SheetTrigger asChild>
        {trigger === "chip" ? (
          <button
            type="button"
            aria-label={`Filters: ${summary}`}
            className={cn(
              "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:bg-raised hover:text-foreground",
              filtered && "border-border-strong bg-raised text-foreground",
              className,
            )}
          >
            {filters.harness ? <HarnessDot id={filters.harness} className="size-2" /> : <SlidersHorizontal aria-hidden className="size-3.5 shrink-0" />}
            <span className="truncate">{summary}</span>
          </button>
        ) : (
          <button type="button" aria-label={filtered ? `Filters: ${summary}` : "Filters"} title="Filters" className={cn(iconButton, "relative", filtered && "text-foreground", className)}>
            <SlidersHorizontal aria-hidden />
            {filtered ? <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-brand" /> : null}
          </button>
        )}
      </SheetTrigger>
      <SheetContent
        side={wide ? "right" : "bottom"}
        showCloseButton={false}
        className={cn(
          "gap-5 px-5",
          wide ? "w-96 py-6 sm:max-w-96" : "max-h-[90dvh] overflow-y-auto rounded-t-xl pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))]",
        )}
      >
        {wide ? null : <div aria-hidden className="mx-auto h-1 w-10 rounded-full bg-border-strong" />}
        <SheetHeader className="p-0">
          <SheetTitle className="text-base tracking-[-0.01em]">Filters</SheetTitle>
          <SheetDescription className="text-xs">Changes apply immediately.</SheetDescription>
        </SheetHeader>
        <Filters {...filters} />
        <SheetClose asChild>
          <Button className="h-11 w-full lg:mt-auto">Done</Button>
        </SheetClose>
      </SheetContent>
    </Sheet>
  )
}
