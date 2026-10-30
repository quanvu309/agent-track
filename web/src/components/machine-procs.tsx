import { type BarRow, HBars } from "@/components/machine-bars"
import { DataTable } from "@/components/data-table"
import { HarnessLabel, Panel } from "@/components/kit"
import { harnessMeta } from "@/lib/harness"
import { OTHER_APPS, agentShareOfUsed, bytes } from "@/lib/machine-health"
import type { MachineNow, TopProc } from "@/lib/types"

const pctOf = (part: number, whole: number) => `${((part / whole) * 100).toFixed(1).replace(/\.0$/, "")}%`

function row(p: TopProc, total: number): BarRow {
  const agent = p.harness ? harnessMeta(p.harness).label : "None"
  return {
    key: String(p.pid),
    label: p.comm,
    note: p.project ?? undefined,
    harness: p.harness ?? "other",
    value: p.mem,
    valueText: bytes(p.mem),
    tip: [
      { label: "Memory", value: bytes(p.mem), strong: true },
      { label: "Share of RAM", value: pctOf(p.mem, total) },
      { label: "Agent", value: agent, color: p.harness ? harnessMeta(p.harness).color : OTHER_APPS.color },
      { label: "Project", value: p.project ?? "None" },
      { label: "Process ID", value: String(p.pid) },
    ],
  }
}

export function ProcsCard({ now, className }: { now: MachineNow | null | undefined; className?: string }) {
  const top = now?.top ?? []
  const share = now ? agentShareOfUsed(now) : 0
  return (
    <Panel
      className={className}
      title="Who holds the RAM"
      description={
        now ? (
          <span data-figure="agent-share" data-value={share}>
            Agents hold <span className="font-medium text-foreground">{pctOf(share, 1)}</span> of used RAM. Top {top.length} processes by private memory, colored when an agent runs them.
          </span>
        ) : undefined
      }
      status={now === undefined ? "loading" : top.length === 0 ? "empty" : "ready"}
      emptyText="No processes sampled yet"
      skeletonHeight={360}
      chart={() => <HBars rows={top.map((p) => row(p, now!.mem_total))} ariaLabel="Top processes by private memory" title={(r) => `${r.label}${r.note ? `, ${r.note}` : ""}`} />}
      table={() => (
        <DataTable
          label="Top processes by memory"
          rows={top}
          rowKey={(p) => String(p.pid)}
          initialSort={{ key: "mem", dir: -1 }}
          columns={[
            { key: "comm", label: "Process", cell: (p) => p.comm, sortValue: (p) => p.comm },
            { key: "project", label: "Project", cell: (p) => p.project ?? "", clip: (p) => p.project ?? "", sortValue: (p) => p.project },
            { key: "agent", label: "Agent", cell: (p) => (p.harness ? <HarnessLabel id={p.harness} /> : ""), sortValue: (p) => p.harness },
            { key: "mem", label: "Memory", num: true, cell: (p) => bytes(p.mem), sortValue: (p) => p.mem },
            { key: "pid", label: "PID", num: true, cell: (p) => p.pid, sortValue: (p) => p.pid },
          ]}
        />
      )}
    />
  )
}
