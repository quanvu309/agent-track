import { cn } from "cn"

import { Empty } from "@/components/kit"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { harnessMeta } from "@/lib/harness"
import {
  LEVEL_COLOR, LEVEL_LABEL, LIMITS, RULE_TEXT, assess, bytes, loadPerCpu, ramSplit, swapShare, uptime,
} from "@/lib/machine-health"
import type { MachineNow } from "@/lib/types"

const share = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "0%")

/** A track with one fill and an optional tick where the gauge turns amber. */
function Gauge({ label, figure, fraction, tick, note, id }: { label: string; figure: string; fraction: number; tick?: number; note: string; id: string }) {
  return (
    <div className="grid min-w-0 gap-1.5" data-figure={id}>
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="font-medium">{label}</span>
        <span className="truncate tabular-nums">{figure}</span>
      </div>
      <div role="img" aria-label={`${label} ${figure}, ${note}`} title={`${label} ${figure}, ${note}`} className="relative h-2 rounded-full bg-muted">
        <div className="absolute inset-y-0 left-0 rounded-full bg-[var(--neutral-series)]" style={{ width: `${Math.min(1, fraction) * 100}%` }} />
        {tick !== undefined ? <div aria-hidden className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground" style={{ left: `${tick * 100}%` }} /> : null}
      </div>
      <p className="truncate text-xs text-muted-foreground tabular-nums">{note}</p>
    </div>
  )
}

function RamSplit({ now }: { now: MachineNow }) {
  const pieces = ramSplit(now, harnessMeta)
  const held = pieces.filter((p) => p.key !== "available")
  const segments = held.map((p, i) => ({
    ...p,
    left: held.slice(0, i).reduce((a, q) => a + q.bytes, 0) / now.mem_total,
    width: p.bytes / now.mem_total,
  }))
  const amberAt = 1 - LIMITS.ramFree.tight
  return (
    <section aria-label="RAM split" className="grid gap-2" data-figure="ram">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-medium">RAM</h3>
        <p className="text-[13px] tabular-nums">
          <span className="font-semibold">{bytes(now.mem_used)}</span>
          <span className="text-muted-foreground"> of {bytes(now.mem_total)} used</span>
        </p>
      </div>
      <div className="relative h-4 rounded-md bg-muted" role="img" aria-label={pieces.map((p) => `${p.label} ${bytes(p.bytes)}`).join(", ")}>
        {segments.map((s, i) =>
          s.bytes > 0 ? (
            <div
              key={s.key}
              title={`${s.label} ${bytes(s.bytes)}, ${share(s.bytes, now.mem_total)} of RAM`}
              className={cn("absolute inset-y-0", i === 0 && "rounded-l-md")}
              style={{ left: `${s.left * 100}%`, width: `max(1px, calc(${s.width * 100}% - 2px))`, background: s.color }}
            />
          ) : null,
        )}
        <div aria-hidden className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground" style={{ left: `${amberAt * 100}%` }} />
      </div>
      <ul className="grid grid-cols-2 gap-x-5 gap-y-1 text-xs sm:grid-cols-3" aria-label="RAM by holder">
        {pieces.map((p) => (
          <li key={p.key} className="flex min-w-0 items-center gap-2" data-key={p.key} data-value={p.bytes}>
            <span aria-hidden className={cn("size-2.5 shrink-0 rounded-[3px]", p.key === "available" && "ring-1 ring-border ring-inset")} style={{ background: p.color }} />
            <span className="truncate text-muted-foreground">{p.label}</span>
            <span className="ml-auto font-medium tabular-nums">{bytes(p.bytes)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function StatusCard({ now, className }: { now: MachineNow | null | undefined; className?: string }) {
  if (now === undefined) return <Skeleton className={cn("h-80 rounded-lg", className)} />
  if (now === null) {
    return (
      <Card className={cn("rounded-lg border-border p-4 shadow-none sm:p-5", className)}>
        <Empty>No machine samples yet. The first one lands within 15 seconds.</Empty>
      </Card>
    )
  }
  const health = assess(now)
  const lpc = loadPerCpu(now)
  const loadMax = Math.max(2, Math.ceil(lpc))
  const [m1, m5, m15] = now.load
  return (
    <Card className={cn("min-w-0 gap-5 rounded-lg border-border px-4 py-4 shadow-none sm:px-5 sm:py-5", className)} data-level={health.level} data-ts={now.ts}>
      <header className="grid gap-1">
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="size-3 shrink-0 rounded-full" style={{ background: LEVEL_COLOR[health.level] }} />
          <h3 className="text-base leading-6 font-semibold tracking-[-0.01em] text-balance">
            <span className="sr-only">{LEVEL_LABEL[health.level]}. </span>
            {health.headline}
          </h3>
        </div>
        <p className="pl-[22px] text-[13px] leading-5 text-muted-foreground">{health.detail}</p>
      </header>
      <RamSplit now={now} />
      <div className="grid gap-4">
        <Gauge
          id="swap"
          label="Swap"
          figure={`${bytes(now.swap_used)} of ${bytes(now.swap_total)}`}
          fraction={swapShare(now)}
          tick={LIMITS.swapUsed.tight}
          note={now.swap_total ? `${share(now.swap_used, now.swap_total)} used` : "No swap"}
        />
        <Gauge
          id="load"
          label="Load"
          figure={`${lpc.toFixed(2)} per CPU`}
          fraction={lpc / loadMax}
          tick={LIMITS.loadPerCpu.tight / loadMax}
          note={`${m1.toFixed(1)}, ${m5.toFixed(1)}, ${m15.toFixed(1)} over 1, 5, 15 min`}
        />
        <Gauge
          id="disk"
          label="Disk"
          figure={`${bytes(now.disk_used)} of ${bytes(now.disk_total)}`}
          fraction={now.disk_used / now.disk_total}
          note={`${share(now.disk_used, now.disk_total)} used`}
        />
      </div>
      <footer className="mt-auto grid gap-3 border-t border-border pt-4">
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
          {[
            ["CPU", now.cpu_pct === null ? "Measuring" : `${Math.round(now.cpu_pct)}%`],
            ["CPUs", String(now.cpus)],
            ["Processes", String(now.procs)],
            ["Up", uptime(now.uptime_s)],
            ["Sampled", new Date(now.ts).toLocaleTimeString("en-GB", { hour12: false })],
          ].map(([k, v]) => (
            <div key={k} className="flex gap-1.5">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="font-medium tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs leading-5 text-muted-foreground">
          {RULE_TEXT} Ticks mark where amber starts. Agents and other apps count private memory. System is the rest of used RAM, like the kernel and shared memory.
        </p>
      </footer>
    </Card>
  )
}
