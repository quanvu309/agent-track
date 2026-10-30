import { useState } from "react"

import { DataTable } from "@/components/data-table"
import { compactFixed, pale, shareText, wholeShares } from "@/components/insights-format"
import { SegBars, ShareBar, type SegRow } from "@/components/insights-marks"
import { Treemap, type TreeGroup } from "@/components/insights-treemap"
import { HarnessLabel, Panel, Segmented } from "@/components/kit"
import { status } from "@/lib/panel-status"
import type { Loaded } from "@/lib/api"
import { fmt, fmtMs, pct } from "@/lib/format"
import { harnessMeta } from "@/lib/harness"
import type { ModelRow, Reliability, ReliabilityTool, ToolRow } from "@/lib/types"

const MODEL_METRICS = [
  ["input_tokens", "Input"],
  ["output_tokens", "Output"],
] as const
type ModelMetric = (typeof MODEL_METRICS)[number][0]
const TOP_MODELS = 12
const CACHE_LIGHTNESS = 0.9

const fresh = (r: ModelRow) => Math.max(0, r.input_tokens - r.cached_tokens)

function KeySwatch({ tone, children }: { tone: "solid" | "pale"; children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className="size-2.5 rounded-[3px] ring-1 ring-border ring-inset" style={{ background: tone === "solid" ? "var(--neutral-series)" : pale("neutral", CACHE_LIGHTNESS) }} />
      {children}
    </span>
  )
}

export function ModelsCard({ models, harness }: { models: Loaded<ModelRow[]>; harness: string | null }) {
  const [metric, setMetric] = useState<ModelMetric>("input_tokens")
  const metricLabel = MODEL_METRICS.find(([k]) => k === metric)![1]
  const all = models.data?.filter((r) => !harness || r.harness === harness) ?? []
  const ranked = [...all].sort((a, b) => b[metric] - a[metric])
  const top = ranked.slice(0, TOP_MODELS)
  const total = all.reduce((a, r) => a + r[metric], 0)
  const whole = wholeShares(ranked.map((r) => r[metric]))
  const shares = new Map(ranked.map((r, i) => [r, whole[i]]))
  const agents = [...new Set(all.map((r) => r.harness))]
  const agentTotal = (h: string) => all.reduce((a, r) => a + (r.harness === h ? r[metric] : 0), 0)
  const byAgent = [...agents].sort((a, b) => agentTotal(b) - agentTotal(a))
  const isInput = metric === "input_tokens"
  const bar = (r: ModelRow): SegRow => {
    const color = harnessMeta(r.harness).color
    return {
      key: `${r.harness}/${r.model}`,
      label: r.model,
      note: agents.length > 1 ? harnessMeta(r.harness).label : undefined,
      parts: isInput ? [{ value: fresh(r), color }, { value: r.cached_tokens, color: pale(r.harness, CACHE_LIGHTNESS) }] : [{ value: r.output_tokens, color }],
      valueText: compactFixed(r[metric]),
      valueNote: shareText(shares.get(r) ?? 0, r[metric]),
      tip: {
        title: `${r.model} · ${harnessMeta(r.harness).label}`,
        rows: [
          { label: metricLabel, value: fmt(r[metric]), color, strong: true },
          ...(isInput ? [{ label: "Fresh", value: fmt(fresh(r)) }, { label: "From cache", value: `${fmt(r.cached_tokens)} · ${pct(r.cached_tokens, r.input_tokens)}` }] : []),
          { label: "Share", value: pct(r[metric], total) },
          { label: "Responses", value: fmt(r.responses) },
        ],
      },
    }
  }
  return (
    <Panel
      title={`${metricLabel} tokens by model`}
      description={all.length > TOP_MODELS ? `Top ${TOP_MODELS} of ${all.length} models, with each one's share` : "With each model's share of the total"}
      controls={<Segmented label="Model metric" fill className="sm:w-auto" options={MODEL_METRICS} value={metric} onChange={setMetric} />}
      legend={
        isInput ? (
          <div className="flex gap-4 text-xs text-muted-foreground">
            <KeySwatch tone="solid">Fresh</KeySwatch>
            <KeySwatch tone="pale">From cache</KeySwatch>
          </div>
        ) : null
      }
      status={status(models.data, () => all.length === 0)}
      stale={models.loading && models.data !== undefined}
      chart={() => (
        <div className="grid gap-5">
          {byAgent.length > 1 ? (
            <section aria-label={`${metricLabel} tokens by agent`} className="grid gap-1">
              <h3 className="flex items-baseline justify-between text-xs text-muted-foreground">
                By agent
                <span className="tabular-nums" title={fmt(total)}>{compactFixed(total)} total</span>
              </h3>
              <ShareBar
                label={`${metricLabel} tokens by agent`}
                tipTitle={(p) => p.label}
                parts={byAgent.map((h) => ({
                  key: h, label: harnessMeta(h).label, value: agentTotal(h), color: harnessMeta(h).color, valueText: compactFixed(agentTotal(h)),
                  tip: [{ label: metricLabel, value: fmt(agentTotal(h)), color: harnessMeta(h).color, strong: true }, { label: "Share", value: pct(agentTotal(h), total) }],
                }))}
              />
            </section>
          ) : null}
          <SegBars label={`${metricLabel} tokens by model`} rows={top.map(bar)} />
        </div>
      )}
      table={() => (
        <DataTable
          label="Tokens by model"
          rows={all}
          rowKey={(r) => `${r.harness}/${r.model}`}
          initialSort={{ key: metric, dir: -1 }}
          maxHeight={420}
          columns={[
            { key: "harness", label: "Agent", cell: (r) => <HarnessLabel id={r.harness} />, sortValue: (r) => r.harness },
            { key: "model", label: "Model", cell: (r) => r.model, clip: (r) => r.model, sortValue: (r) => r.model },
            { key: "responses", label: "Responses", num: true, cell: (r) => fmt(r.responses), sortValue: (r) => r.responses },
            { key: "input_tokens", label: "Input", num: true, cell: (r) => fmt(r.input_tokens), sortValue: (r) => r.input_tokens },
            { key: "cached_tokens", label: "Cached", num: true, cell: (r) => fmt(r.cached_tokens), sortValue: (r) => r.cached_tokens },
            { key: "output_tokens", label: "Output", num: true, cell: (r) => fmt(r.output_tokens), sortValue: (r) => r.output_tokens },
            { key: "share", label: "Share", num: true, cell: (r) => shareText(shares.get(r) ?? 0, r[metric]), sortValue: (r) => r[metric] },
            { key: "cache", label: "Cache %", num: true, cell: (r) => pct(r.cached_tokens, r.input_tokens), sortValue: (r) => (r.input_tokens ? r.cached_tokens / r.input_tokens : null) },
          ]}
        />
      )}
    />
  )
}

const TOOL_METRICS = [
  ["calls", "Calls"],
  ["p95", "Slowest"],
] as const
type ToolMetric = (typeof TOOL_METRICS)[number][0]
const TOP_SLOW = 10

type ToolTile = { harness: string; tool: string; calls: number; other: boolean }

/** The top tools plus one remainder per agent, so the boxes cover every call in the range. */
function toolTiles(tools: ToolRow[], rel: Reliability | undefined): ToolTile[] {
  const tiles: ToolTile[] = tools.map((r) => ({ harness: r.harness, tool: r.tool ?? "Unknown", calls: r.calls, other: false }))
  for (const h of rel?.harnesses ?? []) {
    const listed = tools.reduce((a, r) => a + (r.harness === h.harness ? r.calls : 0), 0)
    if (h.calls > listed) tiles.push({ harness: h.harness, tool: "Other tools", calls: h.calls - listed, other: true })
  }
  return tiles
}

function slowBar(r: ReliabilityTool, note: boolean): SegRow {
  const tool = r.tool ?? "Unknown"
  const color = harnessMeta(r.harness).color
  return {
    key: `${r.harness}/${tool}`,
    label: tool,
    note: note ? harnessMeta(r.harness).label : undefined,
    parts: [{ value: r.p95_ms ?? 0, color }],
    valueText: fmtMs(r.p95_ms),
    tip: {
      title: `${tool} · ${harnessMeta(r.harness).label}`,
      rows: [{ label: "p95", value: fmtMs(r.p95_ms), color, strong: true }, { label: "Average", value: fmtMs(r.avg_ms) }, { label: "Calls", value: fmt(r.calls) }],
    },
  }
}

export function ToolsCard({ tools, reliability }: { tools: Loaded<ToolRow[]>; reliability: Loaded<Reliability> }) {
  const [metric, setMetric] = useState<ToolMetric>("calls")
  const rel = reliability.data
  const tiles = toolTiles(tools.data ?? [], rel)
  const total = tiles.reduce((a, t) => a + t.calls, 0)
  const tileShares = wholeShares(tiles.map((t) => t.calls))
  const shareOf = new Map(tiles.map((t, i) => [t, tileShares[i]]))
  const agentCalls = new Map((rel?.harnesses ?? []).map((h) => [h.harness, h.calls]))
  const agents = [...new Set(tiles.map((t) => t.harness))]
  const agentSum = (h: string) => tiles.reduce((a, t) => a + (t.harness === h ? t.calls : 0), 0)
  const agentShares = wholeShares(agents.map(agentSum))
  const groups: TreeGroup[] = agents.map((h, gi) => {
    const value = agentSum(h)
    return {
      harness: h,
      value,
      valueText: compactFixed(value),
      shareText: `${agentShares[gi]}%`,
      tiles: tiles
        .filter((t) => t.harness === h)
        .map((t) => ({
          key: `${h}/${t.tool}/${t.other}`,
          label: t.tool,
          value: t.calls,
          other: t.other,
          valueText: `${compactFixed(t.calls)} · ${shareText(shareOf.get(t) ?? 0, t.calls)}`,
          aria: `${t.tool}, ${harnessMeta(h).label}, ${fmt(t.calls)} calls, ${pct(t.calls, total)} of all`,
          tip: {
            title: `${t.tool} · ${harnessMeta(h).label}`,
            rows: [
              { label: "Calls", value: fmt(t.calls), color: harnessMeta(h).color, strong: true },
              { label: "Of all calls", value: pct(t.calls, total) },
              { label: `Of ${harnessMeta(h).label}`, value: pct(t.calls, agentCalls.get(h) ?? value) },
            ],
          },
        })),
    }
  })
  const slow = rel?.slowest ?? []
  const slowAgents = new Set(slow.slice(0, TOP_SLOW).map((r) => r.harness))
  const calls = metric === "calls"
  return (
    <Panel
      title={calls ? "Tool calls" : "Slowest tools"}
      description={calls ? "Each box is sized by its calls. Smaller tools are grouped per agent." : "Time within which 95% of a tool's calls finish"}
      controls={<Segmented label="Tool metric" fill className="sm:w-auto" options={TOOL_METRICS} value={metric} onChange={setMetric} />}
      status={calls ? status(tools.data && rel ? tiles : undefined, (d) => d.length === 0) : status(rel, (d) => d.slowest.length === 0)}
      stale={(tools.loading && tools.data !== undefined) || (reliability.loading && rel !== undefined)}
      emptyText={calls ? "No tool calls" : "No timing data"}
      skeletonHeight={360}
      chart={() =>
        calls ? (
          <div className="grid gap-2">
            <Treemap label="Tool calls by agent and tool, sized by calls" groups={groups} />
            <p className="text-xs text-muted-foreground">Hover or tap a box for its calls</p>
          </div>
        ) : (
          <SegBars label="Slowest tools by p95 duration" rows={slow.slice(0, TOP_SLOW).map((r) => slowBar(r, slowAgents.size > 1))} />
        )
      }
      table={() =>
        calls ? (
          <DataTable
            label="Tool calls"
            rows={tiles}
            rowKey={(t) => `${t.harness}/${t.tool}/${t.other}`}
            initialSort={{ key: "calls", dir: -1 }}
            maxHeight={420}
            columns={[
              { key: "harness", label: "Agent", cell: (t) => <HarnessLabel id={t.harness} />, sortValue: (t) => t.harness },
              { key: "tool", label: "Tool", cell: (t) => (t.other ? <span className="text-muted-foreground">{t.tool}</span> : t.tool), clip: (t) => t.tool, sortValue: (t) => t.tool },
              { key: "calls", label: "Calls", num: true, cell: (t) => fmt(t.calls), sortValue: (t) => t.calls },
              { key: "share", label: "Share", num: true, cell: (t) => shareText(shareOf.get(t) ?? 0, t.calls), sortValue: (t) => t.calls },
            ]}
          />
        ) : (
          <DataTable
            label="Slowest tools"
            rows={slow}
            rowKey={(r) => `${r.harness}/${r.tool}`}
            initialSort={{ key: "p95", dir: -1 }}
            maxHeight={420}
            columns={[
              { key: "harness", label: "Agent", cell: (r) => <HarnessLabel id={r.harness} />, sortValue: (r) => r.harness },
              { key: "tool", label: "Tool", cell: (r) => r.tool ?? "Unknown", clip: (r) => r.tool ?? "", sortValue: (r) => r.tool },
              { key: "calls", label: "Calls", num: true, cell: (r) => fmt(r.calls), sortValue: (r) => r.calls },
              { key: "avg", label: "Avg", num: true, cell: (r) => fmtMs(r.avg_ms), sortValue: (r) => r.avg_ms },
              { key: "p95", label: "p95", num: true, cell: (r) => fmtMs(r.p95_ms), sortValue: (r) => r.p95_ms },
            ]}
          />
        )
      }
    />
  )
}
