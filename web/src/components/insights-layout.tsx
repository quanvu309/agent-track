import { useLayoutEffect, useRef, useState } from "react"

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

export type Rect = { x: number; y: number; w: number; h: number }

function worst(row: number[], side: number) {
  const sum = row.reduce((a, v) => a + v, 0)
  return Math.max((side * side * Math.max(...row)) / (sum * sum), (sum * sum) / (side * side * Math.min(...row)))
}

/** Squarified treemap (Bruls, Huizing, van Wijk). Values must be positive and sorted largest first; rects come back in the same order. */
export function squarify(values: number[], rect: Rect): Rect[] {
  const total = values.reduce((a, v) => a + v, 0)
  const areas = values.map((v) => (v / total) * rect.w * rect.h)
  const out: Rect[] = []
  let { x, y, w, h } = rect
  for (let i = 0; i < areas.length; ) {
    const side = Math.min(w, h)
    const row = [areas[i]]
    let j = i + 1
    while (j < areas.length && worst([...row, areas[j]], side) <= worst(row, side)) row.push(areas[j++])
    const sum = row.reduce((a, v) => a + v, 0)
    if (w >= h) {
      const cw = sum / h
      let top = y
      for (const a of row) {
        out.push({ x, y: top, w: cw, h: a / cw })
        top += a / cw
      }
      x += cw
      w -= cw
    } else {
      const rh = sum / w
      let left = x
      for (const a of row) {
        out.push({ x: left, y, w: a / rh, h: rh })
        left += a / rh
      }
      y += rh
      h -= rh
    }
    i = j
  }
  return out
}
