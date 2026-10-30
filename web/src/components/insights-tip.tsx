import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react"

import { TipBox, type TipRow } from "@/components/charts"

export type Tip = { title: string; rows: TipRow[] }
export type BindTip = (tip: Tip) => { onPointerMove: (e: PointerEvent) => void; onPointerDown: (e: PointerEvent) => void }
type Shown = Tip & { x: number; y: number; w: number }

/** A figure whose marks show a tooltip on hover, or on tap on phones. Tapping elsewhere closes it. */
export function TipArea({ label, className, children }: { label: string; className?: string; children: (bind: BindTip) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState<Shown | null>(null)
  const open = shown !== null

  useEffect(() => {
    if (!open) return
    const close = (e: globalThis.PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setShown(null)
    }
    document.addEventListener("pointerdown", close)
    return () => document.removeEventListener("pointerdown", close)
  }, [open])

  const bind: BindTip = (tip) => {
    const at = (e: PointerEvent) => {
      const box = ref.current?.getBoundingClientRect()
      if (box) setShown({ ...tip, x: e.clientX - box.left, y: e.clientY - box.top, w: box.width })
    }
    return { onPointerMove: at, onPointerDown: at }
  }

  const alignX = !shown ? "" : shown.x < 90 ? "-12px" : shown.x > shown.w - 90 ? "calc(-100% + 12px)" : "-50%"
  const alignY = !shown ? "" : shown.y < 96 ? "18px" : "calc(-100% - 14px)"
  return (
    <div
      ref={ref}
      role="figure"
      aria-label={label}
      className={`relative ${className ?? ""}`}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") setShown(null)
      }}
    >
      {children(bind)}
      {shown ? (
        <div className="pointer-events-none absolute z-20" style={{ left: shown.x, top: shown.y, transform: `translate(${alignX}, ${alignY})` }}>
          <TipBox title={shown.title} rows={shown.rows} />
        </div>
      ) : null}
    </div>
  )
}
