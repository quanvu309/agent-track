import { cn } from "cn"

import { StatusIcon } from "@/components/status-icon"
import { TickRules } from "@/components/session-viz"
import { when } from "@/lib/format"
import { harnessMeta } from "@/lib/harness"
import type { Life } from "@/lib/session-life"
import { type Domain, type Tick, at, spanOn } from "@/lib/session-layout"

/** When a session ran, as a bar on the shared clock. Working sessions end in a status glyph. */
export function LifespanBar({ life, domain, ticks, className }: { life: Life | null; domain: Domain; ticks: Tick[]; className?: string }) {
  if (!life) return <span className={cn("block h-3", className)} />
  const { left, width } = spanOn(domain, life.start, life.end)
  const color = harnessMeta(life.harness).color
  const pos = (t: number) => at(domain, t)
  return (
    <span className={cn("relative block h-3", className)} title={`${when(new Date(life.start).toISOString())} to ${when(new Date(life.end).toISOString())}`}>
      <TickRules ticks={ticks} pos={pos} />
      <span aria-hidden className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-muted" />
      <span
        aria-hidden
        className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full"
        style={{ left: `min(${left * 100}%, calc(100% - 6px))`, width: `max(6px, ${width * 100}%)`, background: color }}
      />
      {life.working ? (
        <span className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: `max(${(left + width) * 100}%, 6px)` }}>
          <StatusIcon status="working" size={10} label={false} />
        </span>
      ) : null}
    </span>
  )
}
