import type { MachineNow } from "./types"

export type Level = "ok" | "tight" | "critical"

/** Where each gauge turns amber (tight) or red (critical). The status line and the gauge ticks both read these. */
export const LIMITS = {
  ramFree: { tight: 0.2, critical: 0.1 },
  swapUsed: { tight: 0.5, full: 0.9 },
  loadPerCpu: { tight: 1, critical: 2 },
} as const

export const RULE_TEXT =
  "Amber when available RAM is under 20%, swap is over 50% or load is over 1 per CPU. " +
  "Red when available RAM is under 10%, swap is over 90% with RAM tight, or load is over 2 per CPU."

const RANK: Record<Level, number> = { ok: 0, tight: 1, critical: 2 }

type Factor = { key: "ram" | "swap" | "load"; level: Level; phrase: string }

export type Health = { level: Level; headline: string; detail: string }

export const ramFree = (n: MachineNow) => n.mem_available / n.mem_total
export const swapShare = (n: MachineNow) => (n.swap_total ? n.swap_used / n.swap_total : 0)
export const loadPerCpu = (n: MachineNow) => n.load[0] / n.cpus

function factors(n: MachineNow): Factor[] {
  const free = ramFree(n)
  const ram: Factor =
    free < LIMITS.ramFree.critical ? { key: "ram", level: "critical", phrase: "RAM is almost gone" }
    : free < LIMITS.ramFree.tight ? { key: "ram", level: "tight", phrase: "RAM is getting tight" }
    : { key: "ram", level: "ok", phrase: "" }
  const swap = swapShare(n)
  const swapF: Factor =
    swap >= LIMITS.swapUsed.full
      ? ram.level === "ok" ? { key: "swap", level: "tight", phrase: "swap is full" }
      : { key: "swap", level: "critical", phrase: ram.level === "critical" ? "swap is full" : "swap is full with RAM tight" }
    : swap >= LIMITS.swapUsed.tight ? { key: "swap", level: "tight", phrase: "swap is filling up" }
    : { key: "swap", level: "ok", phrase: "" }
  const load = loadPerCpu(n)
  const loadF: Factor =
    load >= LIMITS.loadPerCpu.critical ? { key: "load", level: "critical", phrase: "the CPUs are overloaded" }
    : load >= LIMITS.loadPerCpu.tight ? { key: "load", level: "tight", phrase: "the CPUs are busy" }
    : { key: "load", level: "ok", phrase: "" }
  return [ram, swapF, loadF]
}

const sentence = (parts: string[]) => {
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** One plain status line from the worst factors, plus what it means. */
export function assess(n: MachineNow): Health {
  const all = factors(n)
  const level = all.reduce<Level>((worst, f) => (RANK[f.level] > RANK[worst] ? f.level : worst), "ok")
  if (level === "ok") return { level, headline: "Healthy", detail: "Plenty of free RAM, swap has room and the CPUs keep up." }
  const worst = all.filter((f) => f.level === level)
  const memory = worst.some((f) => f.key !== "load")
  const detail =
    level === "critical" ? (memory ? "Expect stalls until memory frees up." : "Work is queuing for the CPUs.")
    : "Fine for now, with little headroom."
  return { level, headline: sentence(worst.map((f) => f.phrase)), detail }
}

export const LEVEL_COLOR: Record<Level, string> = {
  ok: "var(--status-working)",
  tight: "var(--status-waiting)",
  critical: "var(--destructive)",
}

export const LEVEL_LABEL: Record<Level, string> = { ok: "OK", tight: "Tight", critical: "Critical" }

export type RamPiece = { key: string; label: string; bytes: number; color: string }

export const AGENT_IDS = ["claude", "codex", "grok"] as const
export const OTHER_APPS = { label: "Other apps", color: "var(--neutral-series)" }
const SYSTEM = { label: "System", color: "var(--muted-foreground)" }

/**
 * Splits RAM into pieces that add up to the total. Agents and other apps count private memory.
 * System is the rest of used RAM. Available is what the kernel can hand out now.
 */
export function ramSplit(n: MachineNow, agentLabel: (id: string) => { label: string; color: string }): RamPiece[] {
  const memOf = (id: string) => n.agents.find((a) => a.harness === id)?.mem ?? 0
  const agents = AGENT_IDS.map((id) => ({ key: id, ...agentLabel(id), bytes: memOf(id) }))
  const other = { key: "other", ...OTHER_APPS, bytes: memOf("other") }
  const held = agents.reduce((a, p) => a + p.bytes, other.bytes)
  return [
    ...agents,
    other,
    { key: "system", ...SYSTEM, bytes: Math.max(0, n.mem_used - held) },
    { key: "available", label: "Available", color: "var(--muted)", bytes: n.mem_available },
  ]
}

export const agentShareOfUsed = (n: MachineNow) =>
  n.mem_used ? n.agents.filter((a) => a.harness !== "other").reduce((s, a) => s + a.mem, 0) / n.mem_used : 0

export function bytes(b: number): string {
  if (b < 1e6) return b ? `${Math.round(b / 1e3)} KB` : "0"
  if (b < 1e9) return `${Math.round(b / 1e6)} MB`
  return `${(b / 1e9).toFixed(b < 1e10 ? 1 : 0)} GB`
}

export function uptime(s: number): string {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  return d ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`
}

/** Round gigabyte ticks from 0 past `max`, at most five of them. */
export function gbTicks(max: number): number[] {
  const step = [1, 2, 4, 5, 10, 20, 50, 100].find((s) => max / (s * 1e9) <= 4) ?? 200
  const ticks = [0]
  while (ticks.length < 2 || ticks[ticks.length - 1] < max) ticks.push(ticks.length * step * 1e9)
  return ticks
}
