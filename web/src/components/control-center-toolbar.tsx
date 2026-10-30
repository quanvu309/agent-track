import { LayoutGrid, List } from "lucide-react"

import { Segmented } from "@/components/kit"
import type { GroupBy } from "@/lib/fleet"
import { fmt } from "@/lib/format"

export type ViewMode = "list" | "board"
export const VIEWS = ["list", "board"] as const satisfies readonly ViewMode[]
export const GROUPS = ["status", "agent", "project"] as const satisfies readonly GroupBy[]

const VIEW_OPTIONS = [
  ["list", <><List aria-hidden className="size-3.5" />List</>],
  ["board", <><LayoutGrid aria-hidden className="size-3.5" />Board</>],
] as const

const GROUP_OPTIONS = [["status", "Status"], ["agent", "Agent"], ["project", "Project"]] as const

/** Linear's view header: the title with a live count on the left, view and grouping on the right. */
export function Toolbar({ count, loading, view, onView, group, onGroup }: {
  count: number
  loading: boolean
  view: ViewMode
  onView: (v: ViewMode) => void
  group: GroupBy
  onGroup: (g: GroupBy) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="mr-auto flex min-w-0 items-baseline gap-2.5">
        <h2 className="text-[15px] leading-5 font-semibold tracking-[-0.01em]">Threads</h2>
        {loading ? null : <p aria-live="polite" className="text-xs text-muted-foreground tabular-nums">{count ? `${fmt(count)} going on now` : "Nothing going on now"}</p>}
      </div>
      <div className="flex w-full flex-wrap gap-2 sm:w-auto">
        <Segmented label="View" options={VIEW_OPTIONS} value={view} onChange={onView} />
        <Segmented label="Group by" options={GROUP_OPTIONS} value={group} onChange={onGroup} />
      </div>
    </div>
  )
}
