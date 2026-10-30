import type { ChartConfig } from "@/components/ui/chart"

type HarnessMeta = { label: string; color: string }

export const HARNESS = {
  claude: { label: "Claude", color: "var(--claude)" },
  codex: { label: "Codex", color: "var(--codex)" },
  grok: { label: "Grok", color: "var(--grok)" },
} as const satisfies Record<string, HarnessMeta>

const OTHER: HarnessMeta = { label: "", color: "var(--neutral-series)" }

export function harnessMeta(id: string): HarnessMeta {
  const known = Object.hasOwn(HARNESS, id) ? HARNESS[id as keyof typeof HARNESS] : null
  return known ?? { ...OTHER, label: id }
}

// Keys come from the static registry only: the chart component writes its config into a <style> tag.
export const HARNESS_CHART_CONFIG = Object.fromEntries(
  Object.entries(HARNESS).map(([id, meta]) => [id, { label: meta.label, color: meta.color }]),
) satisfies ChartConfig
