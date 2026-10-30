import type { ReactNode } from "react"
import { cn } from "cn"

import type { Tick } from "@/lib/session-layout"

export type TipLine = { label: string; value: ReactNode; swatch?: string; strong?: boolean }

/** A hover card above (or below) the point `x, y` inside a relative parent of width `width`, kept inside it horizontally. */
export function Tip({ x, y, width, title, lines, below }: { x: number; y: number; width: number; title: ReactNode; lines: TipLine[]; below?: boolean }) {
  const w = 224
  const left = Math.max(0, Math.min(width - w, x - w / 2))
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-20 grid gap-1.5 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-lg"
      style={{ left, width: w, ...(below ? { top: y + 8 } : { bottom: `calc(100% - ${y}px + 8px)` }) }}
    >
      <div className="font-medium text-foreground">{title}</div>
      {lines.map((l) => (
        <div key={l.label} className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
            {l.swatch ? <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: l.swatch }} /> : null}
            <span className="truncate">{l.label}</span>
          </span>
          <span className={cn("shrink-0 text-foreground tabular-nums", l.strong ? "font-semibold" : "font-medium")}>{l.value}</span>
        </div>
      ))}
    </div>
  )
}

/** Tick labels for a time axis, each centred on its fraction and nudged inside at the edges. */
export function TimeTicks({ ticks, pos, className }: { ticks: Tick[]; pos: (t: number) => number; className?: string }) {
  return (
    <div aria-hidden className={cn("relative h-4 text-[11px] leading-4 text-muted-foreground tabular-nums", className)}>
      {ticks.map((k) => {
        const p = pos(k.t)
        const shift = p < 0.03 ? "0%" : p > 0.97 ? "-100%" : "-50%"
        return (
          <span key={k.t} className="absolute top-0 whitespace-nowrap" style={{ left: `${p * 100}%`, transform: `translateX(${shift})` }}>
            {k.label}
          </span>
        )
      })}
    </div>
  )
}

/** Faint vertical rules at tick positions, drawn behind a mark. */
export function TickRules({ ticks, pos }: { ticks: Tick[]; pos: (t: number) => number }) {
  return (
    <>
      {ticks.map((k) => (
        <span key={k.t} aria-hidden className="absolute inset-y-0 w-px bg-border" style={{ left: `${pos(k.t) * 100}%` }} />
      ))}
    </>
  )
}
