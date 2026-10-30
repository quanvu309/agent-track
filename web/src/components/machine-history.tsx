import type { ReactNode } from "react"
import { Area, AreaChart, CartesianGrid, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from "recharts"

import { TipBox, type TipRow } from "@/components/charts"
import { DataTable } from "@/components/data-table"
import { HarnessDot, Panel, Segmented } from "@/components/kit"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import { HARNESS_CHART_CONFIG, harnessMeta } from "@/lib/harness"
import { AGENT_IDS, OTHER_APPS, bytes, gbTicks } from "@/lib/machine-health"
import type { Machine, MachinePoint } from "@/lib/types"

export type Window = "60" | "360" | "1440"
const WINDOWS = [
  ["60", "1 hour"],
  ["360", "6 hours"],
  ["1440", "24 hours"],
] as const satisfies readonly (readonly [Window, string])[]
const TICK_MIN: Record<Window, number> = { "60": 10, "360": 60, "1440": 240 }

const STACK = [...AGENT_IDS, "other"] as const
type Holder = (typeof STACK)[number]
const holder = (id: Holder) => (id === "other" ? OTHER_APPS : harnessMeta(id))

type Point = { t: number; ram: number; swap: number; cpu: number | null } & Record<Holder, number | null>

function toPoint(s: MachinePoint): Point {
  // Early samples predate the per-agent split, so they show a gap rather than zero.
  const split = Object.keys(s.agents).length > 0
  const agents = Object.fromEntries(STACK.map((k) => [k, split ? s.agents[k] ?? 0 : null])) as Record<Holder, number | null>
  return { t: Date.parse(s.ts), ram: s.mem_used, swap: s.swap_used, cpu: s.cpu_pct, ...agents }
}

const hhmm = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })
const gb = (v: number) => `${Math.round(v / 1e9)} GB`
const RAM = "var(--foreground)"
const SWAP = "var(--neutral-series)"
const TOTAL = "var(--muted-foreground)"

function Key({ color, label, swatch }: { color: string; label: string; swatch?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <span aria-hidden className={swatch ? "size-2.5 rounded-[3px]" : "h-0.5 w-3.5 rounded-full"} style={{ background: color }} />
      {label}
    </span>
  )
}

function Mini({ title, keys, children }: { title: string; keys?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="grid gap-1.5">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-[13px] font-medium">{title}</h3>
        {keys ? <div className="flex flex-wrap gap-x-4 gap-y-1">{keys}</div> : null}
      </header>
      {children}
    </section>
  )
}

function Tip({ active, payload, rows }: { active?: boolean; payload?: readonly { payload?: unknown }[]; rows: (p: Point) => TipRow[] }) {
  const p = active ? (payload?.[0]?.payload as Point | undefined) : undefined
  return p ? <TipBox title={hhmm(p.t)} rows={rows(p)} /> : null
}

export function HistoryCard({
  machine, span, onSpan, className,
}: { machine: Machine | undefined; span: Window; onSpan: (w: Window) => void; className?: string }) {
  const points = machine?.series.map(toPoint) ?? []
  const now = machine?.now
  const end = now ? Date.parse(now.ts) : points.at(-1)?.t ?? 0
  const start = end - Number(span) * 60_000
  const step = TICK_MIN[span] * 60_000
  const ticks: number[] = []
  for (let t = Math.ceil(start / step) * step; t <= end; t += step) ticks.push(t)
  const first = points[0]?.t
  const partial = first !== undefined && first - start > 2 * (machine?.bucket_seconds ?? 15) * 1000
  const averaged = machine && machine.bucket_seconds > 15 ? `Each point averages ${Math.round(machine.bucket_seconds / 60)} min.` : "Sampled every 15 s."
  const xAxis = (show: boolean) => (
    <XAxis
      dataKey="t"
      type="number"
      domain={[start, end]}
      ticks={ticks}
      hide={!show}
      tickFormatter={hhmm}
      tickLine={false}
      axisLine={{ stroke: "var(--border)" }}
      tickMargin={8}
      allowDataOverflow
      className="tabular-nums"
    />
  )
  const memTicks = gbTicks(Math.max(now?.mem_total ?? 0, ...points.map((p) => Math.max(p.ram, p.swap))))
  const stackTicks = gbTicks(Math.max(0, ...points.map((p) => STACK.reduce((a, k) => a + (p[k] ?? 0), 0))))
  const margin = { top: 6, right: 8, bottom: 0, left: 0 }
  const cursor = { stroke: "var(--muted-foreground)", strokeOpacity: 0.4 }

  return (
    <Panel
      className={className}
      title="Memory over time"
      description={partial && first !== undefined ? <>History starts at <span className="font-medium text-foreground">{hhmm(first)}</span>. {averaged}</> : averaged}
      controls={<Segmented label="Time window" value={span} onChange={onSpan} options={WINDOWS} />}
      status={machine === undefined ? "loading" : points.length < 2 ? "empty" : "ready"}
      emptyText={first !== undefined ? `History starts at ${hhmm(first)}. Check back in a minute.` : "No samples yet. The first one lands within 15 seconds."}
      skeletonHeight={420}
      chart={() => (
        <div className="grid gap-5">
          <Mini title="Memory" keys={<><Key color={RAM} label="RAM used" /><Key color={SWAP} label="Swap used" /><Key color={TOTAL} label="Totals" /></>}>
            <ChartContainer config={HARNESS_CHART_CONFIG} className="aspect-auto h-40 w-full" role="figure" aria-label="RAM and swap used over time">
              <ComposedChart data={points} margin={margin} accessibilityLayer>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                {xAxis(false)}
                <YAxis tickLine={false} axisLine={false} width={44} tickMargin={4} tickFormatter={gb} ticks={memTicks} domain={[0, memTicks.at(-1)!]} className="tabular-nums" />
                {now ? <ReferenceLine y={now.mem_total} stroke={TOTAL} /> : null}
                {now?.swap_total ? <ReferenceLine y={now.swap_total} stroke={TOTAL} /> : null}
                <ChartTooltip cursor={cursor} content={(p) => <Tip {...p} rows={(d) => [
                  { label: "RAM used", value: bytes(d.ram), color: RAM, strong: true },
                  { label: "Swap used", value: bytes(d.swap), color: SWAP },
                  ...(now ? [{ label: "RAM total", value: bytes(now.mem_total), color: TOTAL }, { label: "Swap total", value: bytes(now.swap_total), color: TOTAL }] : []),
                ]} />} />
                <Area dataKey="ram" type="linear" stroke={RAM} strokeWidth={2} fill={RAM} fillOpacity={0.08} isAnimationActive={false} />
                <Line dataKey="swap" type="linear" stroke={SWAP} strokeWidth={2} dot={false} isAnimationActive={false} />
              </ComposedChart>
            </ChartContainer>
          </Mini>
          <Mini
            title="RAM by agent"
            keys={STACK.map((k) => (k === "other" ? <Key key={k} color={OTHER_APPS.color} label={OTHER_APPS.label} swatch /> : <span key={k} className="inline-flex items-center gap-2 text-xs text-muted-foreground"><HarnessDot id={k} />{harnessMeta(k).label}</span>))}
          >
            <ChartContainer config={HARNESS_CHART_CONFIG} className="aspect-auto h-36 w-full" role="figure" aria-label="Private memory by agent over time, stacked">
              <AreaChart data={points} margin={margin} accessibilityLayer>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                {xAxis(false)}
                <YAxis tickLine={false} axisLine={false} width={44} tickMargin={4} tickFormatter={gb} ticks={stackTicks} domain={[0, stackTicks.at(-1)!]} className="tabular-nums" />
                <ChartTooltip cursor={cursor} content={(p) => <Tip {...p} rows={(d) => STACK.map((k) => ({ label: holder(k).label, value: d[k] === null ? "n/a" : bytes(d[k]), color: holder(k).color }))} />} />
                {STACK.map((k) => (
                  <Area key={k} dataKey={k} stackId="mem" type="linear" stroke={holder(k).color} strokeWidth={1.5} fill={holder(k).color} fillOpacity={k === "other" ? 0.18 : 0.45} isAnimationActive={false} />
                ))}
              </AreaChart>
            </ChartContainer>
          </Mini>
          <Mini title="CPU">
            <ChartContainer config={HARNESS_CHART_CONFIG} className="aspect-auto h-[92px] w-full" role="figure" aria-label="CPU use over time">
              <ComposedChart data={points} margin={margin} accessibilityLayer>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                {xAxis(true)}
                <YAxis tickLine={false} axisLine={false} width={44} tickMargin={4} domain={[0, 100]} ticks={[0, 50, 100]} tickFormatter={(v: number) => `${v}%`} className="tabular-nums" />
                <ChartTooltip cursor={cursor} content={(p) => <Tip {...p} rows={(d) => [{ label: "CPU", value: d.cpu === null ? "n/a" : `${d.cpu.toFixed(1)}%`, color: RAM, strong: true }]} />} />
                <Line dataKey="cpu" type="linear" stroke={RAM} strokeWidth={1.5} dot={false} connectNulls={false} isAnimationActive={false} />
              </ComposedChart>
            </ChartContainer>
          </Mini>
        </div>
      )}
      table={() => (
        <DataTable
          label="Machine samples"
          maxHeight={420}
          rows={[...points].reverse()}
          rowKey={(p) => String(p.t)}
          columns={[
            { key: "t", label: "Time", cell: (p) => hhmm(p.t) },
            { key: "ram", label: "RAM", num: true, cell: (p) => bytes(p.ram) },
            { key: "swap", label: "Swap", num: true, cell: (p) => bytes(p.swap) },
            { key: "cpu", label: "CPU", num: true, cell: (p) => (p.cpu === null ? "" : `${Math.round(p.cpu)}%`) },
            ...STACK.map((k) => ({ key: k, label: holder(k).label, num: true, cell: (p: Point) => (p[k] === null ? "" : bytes(p[k])) })),
          ]}
        />
      )}
    />
  )
}
