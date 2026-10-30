export class ParseError extends Error {}

export type Parser<T> = (value: unknown, path: string) => T

function fail(path: string, expected: string, value: unknown): never {
  throw new ParseError(`${path}: expected ${expected}, got ${value === null ? "null" : typeof value}`)
}

const str: Parser<string> = (v, p) => (typeof v === "string" ? v : fail(p, "string", v))
const optStr: Parser<string | null> = (v, p) => (v == null ? null : str(v, p))
const num: Parser<number> = (v, p) => (typeof v === "number" && Number.isFinite(v) ? v : fail(p, "number", v))
const optNum: Parser<number | null> = (v, p) => (v == null ? null : num(v, p))
// SQL sums over an empty set come back null and mean zero.
const count: Parser<number> = (v, p) => (v == null ? 0 : num(v, p))
export const STATES = ["working", "idle", "ended"] as const
export type PresenceState = (typeof STATES)[number]
// The server's read of the process and transcript. Absent or null means it has no evidence, so the page falls back to timestamps.
const optState: Parser<PresenceState | null> = (v, p) => (v == null ? null : (STATES.find((s) => s === v) ?? fail(p, STATES.join(" | "), v)))
const bool: Parser<boolean> = (v, p) => (typeof v === "boolean" ? v : fail(p, "boolean", v))

function list<T>(item: Parser<T>): Parser<T[]> {
  return (v, p) => (Array.isArray(v) ? v.map((x, i) => item(x, `${p}[${i}]`)) : fail(p, "array", v))
}

type Shape = Record<string, Parser<unknown>>
type Parsed<S extends Shape> = { [K in keyof S]: S[K] extends Parser<infer T> ? T : never }

function record<S extends Shape>(shape: S): Parser<Parsed<S>> {
  return (v, p) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) fail(p, "object", v)
    const src = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(shape)) out[key] = shape[key](src[key], `${p}.${key}`)
    return out as Parsed<S>
  }
}

const tokens = { input_tokens: count, cached_tokens: count, output_tokens: count }

const summaryHarnessRow = record({ harness: str, sessions: count, ...tokens, prompts: count, tool_calls: count, responses: count })
export type SummaryHarnessRow = ReturnType<typeof summaryHarnessRow>
export const parseSummary = record({ harnesses: list(summaryHarnessRow), last_ingest: optStr, ingest_ms: optNum, ingesting: bool })
export type Summary = ReturnType<typeof parseSummary>

const dailyRow = record({ day: str, harness: str, sessions: count, ...tokens, prompts: count, tool_calls: count, responses: count })
export type DailyRow = ReturnType<typeof dailyRow>
export const parseDaily = list(dailyRow)

const hourlyRow = record({ hour: num, harness: str, sessions: count, prompts: count, tool_calls: count, responses: count, ...tokens })
export type HourlyRow = ReturnType<typeof hourlyRow>
export const parseToday = record({ day: str, rows: list(hourlyRow) })
export type Today = ReturnType<typeof parseToday>

const modelRow = record({ harness: str, model: str, ...tokens, responses: count })
export type ModelRow = ReturnType<typeof modelRow>
export const parseModels = list(modelRow)

const toolRow = record({ harness: str, tool: optStr, calls: count })
export type ToolRow = ReturnType<typeof toolRow>
export const parseTools = list(toolRow)

const reliabilityHarness = record({ harness: str, calls: count, avg_ms: optNum })
export type ReliabilityHarness = ReturnType<typeof reliabilityHarness>
const reliabilityTool = record({ harness: str, tool: optStr, calls: count, avg_ms: optNum, p95_ms: optNum })
export type ReliabilityTool = ReturnType<typeof reliabilityTool>
export const parseReliability = record({ harnesses: list(reliabilityHarness), slowest: list(reliabilityTool) })
export type Reliability = ReturnType<typeof parseReliability>

const heatCell = record({ weekday: num, hour: num, events: count, prompts: count })
export type HeatCell = ReturnType<typeof heatCell>
export const parseHeatmap = list(heatCell)

const projectRowRaw = record({
  project: str, sessions: count, harnesses: optStr, ...tokens, prompts: count, tool_calls: count, last_active: optStr,
})
export type ProjectRow = Omit<ReturnType<typeof projectRowRaw>, "harnesses"> & { harnesses: string[] }
export const parseProjects: Parser<ProjectRow[]> = (v, p) =>
  list(projectRowRaw)(v, p).map((r) => ({ ...r, harnesses: (r.harnesses ?? "").split(",").filter(Boolean) }))

const sessionFields = {
  session_id: str, harness: str, project: optStr, title: optStr, threads: count, started: optStr, first: optStr, last: optStr, models: optStr,
  ...tokens, prompts: count, tool_calls: count, active_s: count,
}
const presenceFields = { state: optState, state_since: optStr, pid: optNum }
const sessionRow = record({ ...sessionFields, ...presenceFields })
export type SessionRow = ReturnType<typeof sessionRow>
export const parseSessions = list(sessionRow)

const threadFields = {
  thread_id: str, parent_thread_id: optStr, title: optStr, model: optStr, started_at: optStr, project: optStr,
  input_tokens: count, output_tokens: count, tool_calls: count, last: optStr,
}
const threadRow = record({ ...threadFields, state: optState })
export type ThreadRow = ReturnType<typeof threadRow>

// A live session carries every thread it spans, so the control center draws sub-agents without one request per session.
const liveThreadRow = record({ ...threadFields, state: optState, failed_tools: count, recent_events: count, recent_tool_calls: count })
export type LiveThreadRow = ReturnType<typeof liveThreadRow>
const liveRow = record({ ...sessionFields, ...presenceFields, recent_events: count, recent_input: count, recent_output: count, recent_tool_calls: count, thread_rows: list(liveThreadRow) })
export type LiveRow = ReturnType<typeof liveRow>
export const parseLive = list(liveRow)

const EVENT_KINDS = ["prompt", "tool_call", "response"] as const
export type EventKind = (typeof EVENT_KINDS)[number]
const eventKind: Parser<EventKind> = (v, p) => EVENT_KINDS.find((k) => k === v) ?? fail(p, EVENT_KINDS.join(" | "), v)

const eventRow = record({
  ts: str, kind: eventKind, thread_id: str, model: optStr, tool: optStr, input_tokens: optNum, cached_tokens: optNum, output_tokens: optNum,
  duration_ms: optNum, text: optStr,
})
export type EventRow = ReturnType<typeof eventRow>

const sessionModel = record({ model: str, ...tokens, responses: count })
export type SessionModelRow = ReturnType<typeof sessionModel>
const sessionTool = record({ tool: optStr, calls: count, avg_ms: optNum })
export type SessionToolRow = ReturnType<typeof sessionTool>

export const parseSessionDetail = record({
  session: sessionRow, threads: list(threadRow), models: list(sessionModel), tools: list(sessionTool), events: list(eventRow),
})
export type SessionDetail = ReturnType<typeof parseSessionDetail>

export const parseIngest = record({ stats: (v) => v, totals: (v) => v })

const numberMap: Parser<Record<string, number>> = (v, p) => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(p, "object", v)
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, num(x, `${p}.${k}`)]))
}

const loadAvg: Parser<[number, number, number]> = (v, p) => {
  const [m1, m5, m15, ...rest] = list(num)(v, p)
  return m15 !== undefined && !rest.length ? [m1, m5, m15] : fail(p, "three numbers", v)
}

const agentMem = record({ harness: str, mem: count, procs: count })
export type AgentMem = ReturnType<typeof agentMem>
const topProc = record({ pid: num, comm: str, harness: optStr, project: optStr, mem: count })
export type TopProc = ReturnType<typeof topProc>
const machineNow = record({
  ts: str, mem_total: num, mem_used: num, mem_available: num, swap_total: num, swap_used: num, cpu_pct: optNum, load: loadAvg, cpus: num,
  uptime_s: num, disk_used: num, disk_total: num, procs: count, agents: list(agentMem), top: list(topProc),
})
export type MachineNow = ReturnType<typeof machineNow>
const machinePoint = record({ ts: str, mem_used: num, swap_used: num, cpu_pct: optNum, agents: numberMap })
export type MachinePoint = ReturnType<typeof machinePoint>
export const parseMachine = record({ now: (v, p) => (v == null ? null : machineNow(v, p)), bucket_seconds: num, series: list(machinePoint) })
export type Machine = ReturnType<typeof parseMachine>

const burnRow = record({ ts: str, harness: str, ...tokens, prompts: count, tool_calls: count, responses: count })
export type BurnRow = ReturnType<typeof burnRow>
export const parseBurn = record({ bucket_minutes: num, since: str, until: str, rows: list(burnRow) })
export type Burn = ReturnType<typeof parseBurn>
