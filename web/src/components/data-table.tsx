import { type CSSProperties, type ReactNode, useState } from "react"
import { ArrowDown, ArrowUp } from "lucide-react"
import { cn } from "cn"

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

export type Column<T> = {
  key: string
  label: string
  num?: boolean
  cell: (row: T) => ReactNode
  sortValue?: (row: T) => string | number | null
  /** Truncates the cell to one line and shows this full text on hover. */
  clip?: (row: T) => string
  className?: string
  /** Hides the column on narrower screens, e.g. "hidden 2xl:table-cell". The value stays in the drill-down. */
  wideOnly?: boolean
  /** Replaces the header text on a column that has no sort, e.g. an axis. `label` stays the accessible name. */
  head?: ReactNode
}

type Sort = { key: string; dir: 1 | -1 }

function sorted<T>(rows: T[], columns: Column<T>[], sort: Sort | null): T[] {
  const col = sort && columns.find((c) => c.key === sort.key)
  if (!sort || !col?.sortValue) return rows
  const val = col.sortValue
  return [...rows].sort((a, b) => {
    const x = val(a)
    const y = val(b)
    if (x == null) return 1
    if (y == null) return -1
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sort.dir
  })
}

export function DataTable<T>({
  columns, rows, rowKey, initialSort, onRowClick, rowLabel, rowClassName, maxHeight, label, alignTop,
}: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T, index: number) => string
  initialSort?: Sort
  onRowClick?: (row: T) => void
  rowLabel?: (row: T) => string
  rowClassName?: (row: T) => string | undefined
  maxHeight?: number
  label: string
  /** Aligns every cell to the top, for rows where one cell can wrap to several lines. */
  alignTop?: boolean
}) {
  const [sort, setSort] = useState<Sort | null>(initialSort ?? null)
  const sortable = initialSort !== undefined
  const view = sorted(rows, columns, sort)
  return (
    <div
      className="-mx-4 sm:-mx-5 [&_[data-slot=table-container]]:overflow-auto [&_[data-slot=table-container]]:px-4 sm:[&_[data-slot=table-container]]:px-5 [&_[data-slot=table-container]]:[max-height:var(--table-max-h)]"
      style={{ "--table-max-h": maxHeight ? `${maxHeight}px` : "none" } as CSSProperties}
    >
      <Table aria-label={label} className="text-[13px]">
        <TableHeader className="sticky top-0 z-10 bg-card [&_tr]:border-b [&_tr]:border-border">
          <TableRow className="hover:bg-transparent">
            {columns.map((c) => {
              const active = sort?.key === c.key
              const ariaSort = active ? (sort.dir > 0 ? "ascending" : "descending") : undefined
              return (
                <TableHead key={c.key} aria-sort={ariaSort} className={cn("h-8 text-[11px] font-medium text-muted-foreground", c.num && "text-right", c.className, c.wideOnly && "hidden 2xl:table-cell")}>
                  {sortable && c.sortValue ? (
                    <button
                      type="button"
                      className={cn(
                        "-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground",
                        active && "text-foreground",
                      )}
                      onClick={() => setSort({ key: c.key, dir: active ? (sort.dir === 1 ? -1 : 1) : c.num ? -1 : 1 })}
                    >
                      {c.label}
                      {active ? sort.dir > 0 ? <ArrowUp aria-hidden className="size-3" /> : <ArrowDown aria-hidden className="size-3" /> : null}
                    </button>
                  ) : c.head ? (
                    <>
                      <span className="sr-only">{c.label}</span>
                      {c.head}
                    </>
                  ) : (
                    c.label
                  )}
                </TableHead>
              )
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.map((r, i) => (
            <TableRow
              key={rowKey(r, i)}
              tabIndex={onRowClick ? 0 : undefined}
              aria-label={onRowClick && rowLabel ? rowLabel(r) : undefined}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              onKeyDown={onRowClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(r) } } : undefined}
              className={cn(onRowClick && "cursor-pointer focus-visible:bg-raised", rowClassName?.(r))}
            >
              {columns.map((c) => {
                const clip = c.clip?.(r)
                return (
                  <TableCell key={c.key} title={clip} className={cn("h-9 py-1.5", alignTop && "align-top", c.num && "text-right tabular-nums", clip === undefined && c.className, c.wideOnly && "hidden 2xl:table-cell")}>
                    {clip === undefined ? c.cell(r) : <div className={cn("max-w-80 truncate", c.className)}>{c.cell(r)}</div>}
                  </TableCell>
                )
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
