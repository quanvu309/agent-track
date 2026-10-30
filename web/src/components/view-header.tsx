import { FilterSheet, type FilterProps } from "@/components/filter-sheet"
import { type IngestProps, RefreshButton, WorkingPill } from "@/components/shell-controls"
import { VIEWS, type ViewId } from "@/lib/views"

type ViewHeaderProps = IngestProps & FilterProps & { view: ViewId; working: number }

/** One header for both layouts. Desktop shows the title and the filters chip. Phone adds the working pill, a Filters button and Refresh. */
export function ViewHeader({ view, working, summary, ingesting, onIngest, ...filters }: ViewHeaderProps) {
  const current = VIEWS.find((v) => v.id === view)!
  return (
    <header className="sticky top-0 z-30 flex h-[calc(3rem+env(safe-area-inset-top))] items-center gap-2 border-b border-border bg-background/85 pt-[env(safe-area-inset-top)] pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))] backdrop-blur sm:px-6">
      <h1 className="min-w-0 truncate text-base leading-6 font-semibold tracking-[-0.01em]">{current.label}</h1>
      <div className="ml-auto flex min-w-0 items-center gap-1">
        <WorkingPill count={working} className="mr-1 lg:hidden" />
        <FilterSheet trigger="chip" className="hidden lg:inline-flex" {...filters} />
        <FilterSheet trigger="icon" className="lg:hidden" {...filters} />
        <RefreshButton summary={summary} ingesting={ingesting} onIngest={onIngest} className="lg:hidden" />
      </div>
    </header>
  )
}
