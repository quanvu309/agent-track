import { Bar, BarChart, Cell, LabelList, XAxis, YAxis } from "recharts"

import { TipBox, type TipRow } from "@/components/charts"
import { useWidth } from "@/components/insights-layout"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import { HARNESS_CHART_CONFIG, harnessMeta } from "@/lib/harness"

/** `note` is muted text after the label (e.g. the agent), `valueNote` is muted text after the value (e.g. a share). */
export type BarRow = { key: string; label: string; harness: string; value: number; valueText: string; tip: TipRow[]; note?: string; valueNote?: string }

const truncate = (text: string, chars: number) => (text.length > chars ? `${text.slice(0, Math.max(1, chars - 1))}…` : text)

function BarLabel({ row, chars, ...text }: { row: BarRow | undefined; chars: number; x: number; y: number; dy?: string; textAnchor?: "start" | "end" }) {
  if (!row) return null
  const room = row.note ? Math.max(4, chars - row.note.length - 1) : chars
  return (
    <text {...text} className="text-xs">
      <tspan className="fill-foreground">{truncate(row.label, room)}</tspan>
      {row.note ? <tspan className="fill-muted-foreground text-[11px]" dx={6}>{row.note}</tspan> : null}
    </text>
  )
}

/** One horizontal bar per row, colored by the row's harness, value at the tip. Narrow cards put each label above its bar. */
export function HBars({ rows, ariaLabel, title, max }: { rows: BarRow[]; ariaLabel: string; title?: (row: BarRow) => string; max?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const above = width > 0 && width < 480
  const labelWidth = above ? 0 : Math.min(220, Math.max(110, width * 0.36))
  const chars = Math.floor((above ? width - 64 : labelWidth - 8) / 7.2)
  const rowHeight = above ? 42 : 30
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const valueChars = Math.max(0, ...rows.map((r) => r.valueText.length + (r.valueNote ? r.valueNote.length + 1 : 0)))
  const valueWidth = Math.max(56, Math.ceil(valueChars * 6.8) + 16)
  return (
    <div ref={ref} role="figure" aria-label={ariaLabel}>
      <ChartContainer config={HARNESS_CHART_CONFIG} className="aspect-auto w-full" style={{ height: rows.length * rowHeight + 8 }}>
        <BarChart data={rows} layout="vertical" margin={{ top: above ? 14 : 4, right: valueWidth, bottom: 4, left: 0 }} barCategoryGap={above ? 14 : 8} accessibilityLayer>
          <XAxis type="number" hide domain={[0, max ?? "dataMax"]} />
          <YAxis
            type="category"
            dataKey="key"
            width={labelWidth}
            hide={above}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
            tickMargin={8}
            interval={0}
            tick={(p: { x: number | string; y: number | string; payload: { value: unknown } }) => (
              <BarLabel row={byKey.get(String(p.payload.value))} chars={chars} x={Number(p.x)} y={Number(p.y)} dy="0.355em" textAnchor="end" />
            )}
          />
          <ChartTooltip
            cursor={{ fill: "var(--muted)", radius: 4 }}
            content={({ active, payload }) => {
              const row = active ? (payload?.[0]?.payload as BarRow | undefined) : undefined
              return row ? <TipBox title={title ? title(row) : row.label} rows={row.tip} /> : null
            }}
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={14} minPointSize={2} isAnimationActive={false}>
            {rows.map((r) => (
              <Cell key={r.key} fill={harnessMeta(r.harness).color} />
            ))}
            <LabelList
              dataKey="key"
              content={(p) => {
                const row = byKey.get(String(p.value))
                if (!row) return null
                return (
                  <text x={Number(p.x ?? 0) + Number(p.width ?? 0) + 8} y={Number(p.y ?? 0) + Number(p.height ?? 0) / 2} dy="0.355em" className="text-xs tabular-nums">
                    <tspan className="fill-foreground">{row.valueText}</tspan>
                    {row.valueNote ? <tspan className="fill-muted-foreground" dx={5}>{row.valueNote}</tspan> : null}
                  </text>
                )
              }}
            />
            {above ? (
              <LabelList dataKey="key" content={(p) => <BarLabel row={byKey.get(String(p.value))} chars={chars} x={Number(p.x ?? 0)} y={Number(p.y ?? 0) - 5} />} />
            ) : null}
          </Bar>
        </BarChart>
      </ChartContainer>
    </div>
  )
}
