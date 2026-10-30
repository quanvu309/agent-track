import { cn } from "cn"

import { FilterSheet, type FilterProps } from "@/components/filter-sheet"
import { type IngestProps, IngestLine, LiveBadge, RefreshButton, WorkingPill } from "@/components/shell-controls"
import { VIEWS, type ViewId } from "@/lib/views"

type SidebarProps = IngestProps &
  FilterProps & { view: ViewId; onView: (v: ViewId) => void; live: number; working: number }

export function Sidebar({ view, onView, live, working, summary, ingesting, onIngest, ...filters }: SidebarProps) {
  return (
    <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border bg-sidebar px-3 py-4 lg:flex">
      <div className="flex items-start justify-between gap-2 px-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] leading-5 font-semibold tracking-[-0.01em]">Agent control</p>
        </div>
        <WorkingPill count={working} className="mt-0.5" />
      </div>
      <nav aria-label="Views" className="mt-5 grid gap-0.5">
        {VIEWS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-current={view === id ? "page" : undefined}
            onClick={() => onView(id)}
            className={cn(
              "flex h-8 items-center gap-2 rounded-md px-2 text-left text-[13px] font-medium transition-colors duration-150",
              view === id ? "bg-foreground/[0.08] text-foreground" : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
            )}
          >
            <Icon aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
            <span className="truncate">{label}</span>
            {id === "now" ? <LiveBadge count={live} className="ml-auto" /> : null}
          </button>
        ))}
      </nav>
      <div className="mt-auto grid gap-2">
        <IngestLine summary={summary} ingesting={ingesting} className="px-2" />
        <div className="flex items-center gap-0.5">
          <RefreshButton summary={summary} ingesting={ingesting} onIngest={onIngest} />
          <FilterSheet trigger="icon" {...filters} />
        </div>
      </div>
    </aside>
  )
}
