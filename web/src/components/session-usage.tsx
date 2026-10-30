import { compact, fmt, fmtMs, pct } from "@/lib/format"
import { harnessMeta } from "@/lib/harness"
import type { SessionModelRow, SessionToolRow } from "@/lib/types"

const CACHED_ALPHA = 0.28
const FRESH_ALPHA = 0.6

function Swatch({ color, alpha }: { color: string; alpha: number }) {
  return <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: color, opacity: alpha }} />
}

/** Segments laid end to end with a 2px gap; any non-zero part keeps a visible sliver. */
function Segments({ parts, scale }: { parts: { value: number; color: string; alpha: number }[]; scale: number }) {
  const shown = parts.filter((p) => p.value > 0)
  return (
    <span aria-hidden className="block h-2 overflow-hidden rounded-[3px] bg-muted">
      <span className="flex h-full gap-px" style={{ width: `${scale * 100}%`, minWidth: shown.length * 4 }}>
        {shown.map((p, i) => (
          <span key={i} className="h-full min-w-0.5" style={{ flexGrow: p.value, flexBasis: 0, background: p.color, opacity: p.alpha }} />
        ))}
      </span>
    </span>
  )
}

/** Tokens per model on one scale, split into cached input, the rest of the input, and output. */
export function ModelBars({ models, harness }: { models: SessionModelRow[]; harness: string }) {
  const color = harnessMeta(harness).color
  const rows = [...models].sort((a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens))
  const max = Math.max(1, ...rows.map((r) => r.input_tokens + r.output_tokens))
  return (
    <div className="grid gap-3">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
        <li className="inline-flex items-center gap-1.5"><Swatch color={color} alpha={CACHED_ALPHA} />Cached input</li>
        <li className="inline-flex items-center gap-1.5"><Swatch color={color} alpha={FRESH_ALPHA} />Other input</li>
        <li className="inline-flex items-center gap-1.5"><Swatch color={color} alpha={1} />Output</li>
      </ul>
      <ul className="grid gap-3" aria-label="Tokens by model">
        {rows.map((r) => (
          <li key={r.model} className="grid gap-1.5 text-xs">
            <span className="flex min-w-0 items-baseline justify-between gap-3">
              <span className="min-w-0 truncate font-medium text-foreground" title={r.model}>{r.model}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">{fmt(r.responses)} {r.responses === 1 ? "response" : "responses"}</span>
            </span>
            <Segments
              scale={(r.input_tokens + r.output_tokens) / max}
              parts={[
                { value: r.cached_tokens, color, alpha: CACHED_ALPHA },
                { value: r.input_tokens - r.cached_tokens, color, alpha: FRESH_ALPHA },
                { value: r.output_tokens, color, alpha: 1 },
              ]}
            />
            <span className="text-muted-foreground tabular-nums">
              Input <span className="text-foreground" title={fmt(r.input_tokens)}>{compact(r.input_tokens)}</span>, {pct(r.cached_tokens, r.input_tokens)} cached · Output{" "}
              <span className="text-foreground" title={fmt(r.output_tokens)}>{compact(r.output_tokens)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Calls per tool as bars on one scale, with the average duration where it was recorded. */
export function ToolBars({ tools, harness }: { tools: SessionToolRow[]; harness: string }) {
  const color = harnessMeta(harness).color
  const max = Math.max(1, ...tools.map((t) => t.calls))
  return (
    <ul className="grid gap-2.5" aria-label="Tool calls by tool">
      {tools.map((t) => (
        <li key={t.tool ?? "Unknown"} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1 text-xs">
          <span className="min-w-0 truncate font-medium text-foreground" title={t.tool ?? undefined}>{t.tool ?? "Unknown"}</span>
          <span className="text-muted-foreground tabular-nums">
            <span className="font-medium text-foreground">{fmt(t.calls)}</span>
            {t.avg_ms != null ? ` · avg ${fmtMs(t.avg_ms)}` : ""}
          </span>
          <span aria-hidden className="col-span-2 block h-1.5 overflow-hidden rounded-[3px] bg-muted">
            <span className="block h-full rounded-[3px]" style={{ width: `max(2px, ${(t.calls / max) * 100}%)`, background: color }} />
          </span>
        </li>
      ))}
    </ul>
  )
}
