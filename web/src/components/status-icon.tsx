import { cn } from "cn"

import { STATUS, type ThreadStatus } from "@/lib/fleet"

const COLOR: Record<ThreadStatus, string> = {
  working: "var(--status-working)",
  waiting: "var(--status-waiting)",
  ended: "var(--status-ended)",
}

/**
 * Linear-style status glyph, 14 px. Working is a filled dot with a soft pulse ring, waiting is a half-filled ring, ended is a hollow ring.
 * `label` false hides the accessible name, for rows that already say the status in text.
 */
export function StatusIcon({ status, className, size = 14, label = true }: { status: ThreadStatus; className?: string; size?: number; label?: boolean }) {
  const color = COLOR[status]
  const c = size / 2
  const r = c - 1.5
  const inner = r - Math.max(1.25, r * 0.35)
  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
      role={label ? "img" : undefined}
      aria-label={label ? STATUS[status].label : undefined}
      aria-hidden={label ? undefined : true}
      title={STATUS[status].hint}
    >
      {status === "working" ? (
        <span aria-hidden className="absolute inset-0 rounded-full opacity-50 motion-safe:animate-[pulse-ring_2s_ease-out_infinite]" style={{ background: color }} />
      ) : null}
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="relative">
        <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth={1.5} />
        {status === "working" ? <circle cx={c} cy={c} r={inner} fill={color} /> : null}
        {status === "waiting" ? <path d={`M ${c} ${c - inner} A ${inner} ${inner} 0 0 1 ${c} ${c + inner} Z`} fill={color} /> : null}
      </svg>
    </span>
  )
}

/** Up to `max` tiny status dots side by side, for a session row's sub-agents. */
export function StatusDots({ statuses, max = 5, className }: { statuses: ThreadStatus[]; max?: number; className?: string }) {
  const shown = statuses.slice(0, max)
  const extra = statuses.length - shown.length
  return (
    <span className={cn("inline-flex items-center gap-[3px]", className)} aria-hidden>
      {shown.map((s, i) => <span key={i} className="size-1.5 rounded-full" style={{ background: COLOR[s], opacity: s === "ended" ? 0.7 : 1 }} />)}
      {extra > 0 ? <span className="pl-0.5 text-[10px] leading-none text-muted-foreground tabular-nums">+{extra}</span> : null}
    </span>
  )
}
