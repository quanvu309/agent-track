import { harnessMeta } from "@/lib/harness"

/** Like `compact` but keeps one decimal below 100, so 2.0B sits next to 1.9B without a ragged edge. */
export function compactFixed(n: number): string {
  const abs = Math.abs(n)
  for (const [limit, suffix] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (abs >= limit) {
      const v = n / limit
      return (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)) + suffix
    }
  }
  return String(Math.round(n))
}

/** Whole percents by largest remainder, so the labels of one whole always add up to 100. */
export function wholeShares(values: number[]): number[] {
  const total = values.reduce((a, v) => a + v, 0)
  if (!total) return values.map(() => 0)
  const raw = values.map((v) => (v / total) * 100)
  const out = raw.map(Math.floor)
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0])
  for (let k = 0, left = 100 - out.reduce((a, v) => a + v, 0); k < left; k++) out[order[k][1]] += 1
  return out
}

export const shareText = (whole: number, value: number) => (value > 0 && whole === 0 ? "<1%" : `${whole}%`)

/** Lighter steps of one agent color, for parts of a whole that all belong to that agent. */
export const tint = (color: string, percent: number) => `color-mix(in oklab, ${color} ${percent}%, var(--card))`

// OKLCH lightness of each agent color. A fixed mix percentage would leave Grok's near-black pale steps visibly darker than the others, so pale steps target a lightness instead.
const BASE_LIGHTNESS: Record<string, number> = { claude: 0.67, codex: 0.62, grok: 0.22 }

/** A pale step of an agent's color at about the same lightness for every agent. */
export function pale(harness: string, lightness: number): string {
  const base = BASE_LIGHTNESS[harness] ?? 0.45
  return tint(harnessMeta(harness).color, Math.round(Math.min(1, (1 - lightness) / (1 - base)) * 100))
}
