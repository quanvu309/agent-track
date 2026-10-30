import type { ReactNode } from "react"
import { ChevronRight } from "lucide-react"

import { StatusIcon } from "@/components/status-icon"
import { AgentName, SessionTitle, ShareBar } from "@/components/session-bits"
import { statusOf } from "@/lib/fleet"
import { projectTail } from "@/lib/session-format"

type SessionLike = { session_id: string; harness: string; title: string | null; project: string | null; last: string | null }

/** The phone layout for session tables: one tappable row per session with a few key figures. */
export function SessionCards<T extends SessionLike>({
  rows, figures, onOpen, label, share, mark, now, project = projectTail,
}: {
  rows: T[]
  figures: (row: T) => [string, ReactNode][]
  onOpen: (id: string) => void
  label: string
  /** Draws a thin bar under the row with a label at its end. `value` is 0..1 of the busiest row. */
  share?: (row: T) => { value: number; label: ReactNode }
  /** A full-width mark under the row, e.g. when the session ran. */
  mark?: (row: T) => ReactNode
  /** Epoch ms, for each row's status glyph. */
  now: number
  /** Names a project path. Defaults to its last two folders. */
  project?: (path: string | null) => string
}) {
  return (
    <ul aria-label={label} className="-mx-4 divide-y divide-border border-t border-border sm:-mx-5">
      {rows.map((r) => (
        <li key={r.session_id}>
          <button
            type="button"
            onClick={() => onOpen(r.session_id)}
            className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left sm:px-5 transition-colors duration-150 ease-out hover:bg-raised focus-visible:bg-raised active:bg-secondary"
          >
            <span className="grid min-w-0 flex-1 gap-1.5">
              <span className="flex min-w-0 items-center gap-2">
                <StatusIcon status={statusOf(r, now)} />
                <SessionTitle raw={r.title} className="min-w-0 text-[13px]" />
              </span>
              <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                <AgentName id={r.harness} />
                <span aria-hidden>·</span>
                <span className="truncate" title={r.project ?? ""}>{project(r.project)}</span>
              </span>
              <span className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs">
                {figures(r).map(([k, v]) => (
                  <span key={k} className="inline-flex items-center gap-1 whitespace-nowrap">
                    {k ? <span className="text-muted-foreground">{k}</span> : null}
                    <span className="font-medium tabular-nums">{v}</span>
                  </span>
                ))}
              </span>
              {share ? (
                <span className="flex items-center gap-2 text-xs">
                  <ShareBar share={share(r).value} className="flex-1" />
                  <span className="shrink-0 tabular-nums">{share(r).label}</span>
                </span>
              ) : null}
              {mark ? mark(r) : null}
            </span>
            <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </li>
      ))}
    </ul>
  )
}
