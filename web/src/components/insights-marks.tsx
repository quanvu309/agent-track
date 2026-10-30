import type { TipRow } from "@/components/charts"
import { shareText, wholeShares } from "@/components/insights-format"
import { TipArea, type Tip } from "@/components/insights-tip"
import { fmt } from "@/lib/format"

export type SharePart = { key: string; label: string; value: number; color: string; valueText: string; tip: TipRow[] }

/** One whole split into parts, with each part named under the bar. Labels always add up to 100%. */
export function ShareBar({ parts, label, tipTitle }: { parts: SharePart[]; label: string; tipTitle: (part: SharePart) => string }) {
  const whole = wholeShares(parts.map((p) => p.value))
  const drawn = parts.filter((p) => p.value > 0)
  return (
    <div className="grid gap-1.5">
      <TipArea label={label}>
        {(bind) => (
          <div className="flex gap-0.5">
            {drawn.map((p, i) => (
              <div key={p.key} className="flex h-6 items-center" style={{ flex: `${p.value} 1 0px`, minWidth: 3 }} {...bind({ title: tipTitle(p), rows: p.tip })}>
                <div
                  className={`h-3 w-full ${i === 0 ? "rounded-l-[4px]" : ""} ${i === drawn.length - 1 ? "rounded-r-[4px]" : ""}`}
                  style={{ background: p.color }}
                />
              </div>
            ))}
          </div>
        )}
      </TipArea>
      <dl className="flex flex-wrap justify-between gap-x-4 gap-y-2">
        {parts.map((p, i) => (
          <div key={p.key} className="grid gap-0.5">
            <dt className="flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
              <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={{ background: p.color }} />
              {p.label}
            </dt>
            <dd className="text-[13px] leading-5 font-medium tabular-nums" title={fmt(p.value)}>
              {p.valueText}
              <span className="font-normal text-muted-foreground"> · {shareText(whole[i], p.value)}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** A value with its share of a whole drawn as a thin bar on a fixed 0 to 100% track. */
export function Meter({ label, value, valueText, fraction, share, color }: { label: string; value: number; valueText: string; fraction: number; share: number; color: string }) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">
          <span className="text-[13px] font-medium" title={fmt(value)}>{valueText}</span>
          <span className="text-muted-foreground"> · {shareText(share, value)} of all</span>
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-muted" role="meter" aria-label={`${label}, share of all agents`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={share}>
        <div className="h-full rounded-full" style={{ width: `${fraction * 100}%`, background: color }} />
      </div>
    </div>
  )
}

export type SegRow = { key: string; label: string; note?: string; parts: { value: number; color: string }[]; valueText: string; valueNote?: string; tip: Tip }

/** Ranked horizontal bars on one zero-based scale. A bar can be split into parts, the first one anchored to the baseline. Narrow cards put each label above its bar. */
export function SegBars({ rows, label }: { rows: SegRow[]; label: string }) {
  const total = (r: SegRow) => r.parts.reduce((a, p) => a + p.value, 0)
  const max = Math.max(1, ...rows.map(total))
  return (
    <TipArea label={label}>
      {(bind) => (
        <ul className="grid gap-1.5 @lg:gap-0.5">
          {rows.map((r) => {
            const drawn = r.parts.filter((p) => p.value > 0)
            return (
              <li
                key={r.key}
                className="grid min-w-0 rounded-md px-1 py-0.5 hover:bg-raised @lg:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] @lg:items-center @lg:gap-3"
                {...bind(r.tip)}
              >
                <div className="flex min-w-0 items-baseline gap-1.5 text-xs @lg:justify-end">
                  <span className="truncate">{r.label}</span>
                  {r.note ? <span className="shrink-0 text-[11px] text-muted-foreground">{r.note}</span> : null}
                </div>
                <div className="flex h-6 min-w-0 items-center gap-2">
                  <div className="flex h-3.5 gap-0.5" style={{ width: `calc((100% - 7.5rem) * ${total(r) / max})`, minWidth: 2 }}>
                    {drawn.map((p, i) => (
                      <div
                        key={i}
                        className={i === drawn.length - 1 ? "rounded-r-[4px]" : ""}
                        style={{ flex: `${p.value} 1 0px`, minWidth: 2, background: p.color }}
                      />
                    ))}
                  </div>
                  <span className="shrink-0 text-xs tabular-nums">
                    {r.valueText}
                    {r.valueNote ? <span className="text-muted-foreground"> {r.valueNote}</span> : null}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </TipArea>
  )
}
