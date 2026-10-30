/** Geometry for the session visuals: time axes, event buckets, the projects treemap and thread lanes. Pure, so a script can check it. */

export type Domain = { start: number; end: number }
export type Tick = { t: number; label: string }

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const TICK_STEPS = [SEC, 2 * SEC, 5 * SEC, 10 * SEC, 15 * SEC, 30 * SEC, MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 28 * DAY]
const BUCKET_STEPS = TICK_STEPS.slice(0, 19)

const localMidnight = (t: number) => new Date(t).setHours(0, 0, 0, 0)

/** Step boundaries counted from local midnight, so hour ticks land on whole hours and day ticks on midnights. */
function boundaries(start: number, end: number, step: number): number[] {
  const out: number[] = []
  if (step >= DAY) {
    const days = step / DAY
    const d = new Date(localMidnight(start))
    if (d.getTime() < start) d.setDate(d.getDate() + 1)
    for (; d.getTime() <= end; d.setDate(d.getDate() + days)) out.push(d.getTime())
    return out
  }
  const anchor = localMidnight(start)
  for (let t = anchor + Math.ceil((start - anchor) / step) * step; t <= end; t += step) out.push(t)
  return out
}

const dateLabel = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })
const clock = (t: number, seconds: boolean) =>
  new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: false })

/** At most `max` round ticks inside the domain. Midnights inside an hourly axis read as the date. */
export function timeTicks(d: Domain, max: number): Tick[] {
  const step = TICK_STEPS.find((s) => boundaries(d.start, d.end, s).length <= max) ?? TICK_STEPS[TICK_STEPS.length - 1]
  return boundaries(d.start, d.end, step).map((t) => ({
    t,
    label: step >= DAY || t === localMidnight(t) ? dateLabel(t) : clock(t, step < MIN),
  }))
}

/** Where `t` sits on the domain, 0..1. */
export function at(d: Domain, t: number): number {
  const span = d.end - d.start
  if (span <= 0) return 0.5
  return Math.min(1, Math.max(0, (t - d.start) / span))
}

/** Left edge and width as fractions of the domain. A zero-length span keeps zero width; the mark gives it a minimum size. */
export function spanOn(d: Domain, start: number, end: number): { left: number; width: number } {
  const left = at(d, start)
  return { left, width: Math.max(0, at(d, Math.max(start, end)) - left) }
}

export type Kind = "prompt" | "tool_call" | "response"
export type Bucket = { start: number; end: number } & Record<Kind, number>

/** Counts events per round time bucket, picking the smallest step that keeps at most `target` buckets. */
export function bucketEvents(events: { ts: string; kind: Kind }[], target: number): { step: number; domain: Domain; buckets: Bucket[] } | null {
  if (!events.length) return null
  const times = events.map((e) => Date.parse(e.ts))
  const first = Math.min(...times)
  const last = Math.max(...times)
  const anchor = localMidnight(first)
  const floor = (t: number, step: number) => anchor + Math.floor((t - anchor) / step) * step
  const step = BUCKET_STEPS.find((s) => (floor(last, s) - floor(first, s)) / s + 1 <= target) ?? BUCKET_STEPS[BUCKET_STEPS.length - 1]
  const start = floor(first, step)
  const count = (floor(last, step) - start) / step + 1
  const buckets: Bucket[] = Array.from({ length: count }, (_, i) => ({ start: start + i * step, end: start + (i + 1) * step, prompt: 0, tool_call: 0, response: 0 }))
  events.forEach((e, i) => {
    buckets[Math.round((floor(times[i], step) - start) / step)][e.kind] += 1
  })
  return { step, domain: { start, end: start + count * step }, buckets }
}

export type Rect = { x: number; y: number; w: number; h: number }

const worst = (areas: number[], side: number) => {
  const sum = areas.reduce((a, b) => a + b, 0)
  const max = Math.max(...areas)
  const min = Math.min(...areas)
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min))
}

/** Squarified treemap. Items must be sorted largest first; zero values get no tile. */
export function squarify<T>(items: { value: number; item: T }[], box: Rect): (Rect & { item: T })[] {
  const total = items.reduce((a, b) => a + Math.max(0, b.value), 0)
  if (total <= 0 || box.w <= 0 || box.h <= 0) return []
  const scale = (box.w * box.h) / total
  const queue = items.filter((i) => i.value > 0).map((i) => ({ area: i.value * scale, item: i.item }))
  const out: (Rect & { item: T })[] = []
  let free = { ...box }
  while (queue.length) {
    const side = Math.min(free.w, free.h)
    const row = [queue.shift()!]
    while (queue.length && worst([...row, queue[0]].map((r) => r.area), side) <= worst(row.map((r) => r.area), side)) row.push(queue.shift()!)
    const rowArea = row.reduce((a, r) => a + r.area, 0)
    if (free.w >= free.h) {
      const w = rowArea / free.h
      let y = free.y
      for (const r of row) {
        const h = r.area / w
        out.push({ x: free.x, y, w, h, item: r.item })
        y += h
      }
      free = { x: free.x + w, y: free.y, w: free.w - w, h: free.h }
    } else {
      const h = rowArea / free.w
      let x = free.x
      for (const r of row) {
        const w = r.area / h
        out.push({ x, y: free.y, w, h, item: r.item })
        x += w
      }
      free = { x: free.x, y: free.y + h, w: free.w, h: free.h - h }
    }
  }
  return out
}

/** Greedy interval packing: each span takes the first lane that is free `gap` before it starts. Returns the lane index per input, in input order. */
export function packLanes(spans: { start: number; end: number }[], gap: number): { lanes: number[]; count: number } {
  const order = spans.map((_, i) => i).sort((a, b) => spans[a].start - spans[b].start)
  const laneEnd: number[] = []
  const lanes: number[] = new Array(spans.length)
  for (const i of order) {
    const s = spans[i]
    let lane = laneEnd.findIndex((end) => end + gap <= s.start)
    if (lane === -1) lane = laneEnd.push(0) - 1
    laneEnd[lane] = Math.max(s.start, s.end)
    lanes[i] = lane
  }
  return { lanes, count: laneEnd.length }
}
