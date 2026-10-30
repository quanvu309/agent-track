import { pale } from "@/components/insights-format"
import { squarify, useWidth } from "@/components/insights-layout"
import { TipArea, type Tip } from "@/components/insights-tip"
import { harnessMeta } from "@/lib/harness"

export type TreeTile = { key: string; label: string; value: number; other?: boolean; tip: Tip; aria: string; valueText: string }
export type TreeGroup = { harness: string; value: number; valueText: string; shareText: string; tiles: TreeTile[] }

const GROUP_GAP = 2
const TILE_GAP = 1

/** Tool calls as nested boxes, one group per agent. Box area is proportional to the value across the whole map. */
const fits = (text: string, charPx: number, w: number) => text.length * charPx + 16 <= w

export function Treemap({ groups, label }: { groups: TreeGroup[]; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const height = width < 480 ? 440 : 360
  const sorted = groups.filter((g) => g.value > 0).sort((a, b) => b.value - a.value)
  const groupRects = width ? squarify(sorted.map((g) => g.value), { x: 0, y: 0, w: width, h: height }) : []
  const tiles = groupRects.flatMap((gr, gi) => {
    const g = sorted[gi]
    const list = g.tiles.filter((t) => t.value > 0).sort((a, b) => b.value - a.value)
    const inner = { x: gr.x + GROUP_GAP, y: gr.y + GROUP_GAP, w: Math.max(0, gr.w - 2 * GROUP_GAP), h: Math.max(0, gr.h - 2 * GROUP_GAP) }
    const rects = squarify(list.map((t) => t.value), inner)
    const leadKey = list.find((t) => !t.other)?.key
    return list.map((t, i) => ({ t, g, r: rects[i], lead: t.key === leadKey }))
  })
  return (
    <div ref={ref} className="w-full">
      <TipArea label={label}>
        {(bind) => (
          <ul style={{ height }} className="relative w-full">
            {tiles.map(({ t, g, r, lead }) => {
              const color = harnessMeta(g.harness).color
              const w = Math.max(0, r.w - 2 * TILE_GAP)
              const h = Math.max(0, r.h - 2 * TILE_GAP)
              const header = lead && w >= 96 && h >= 62
              const name = h >= 22 && (fits(t.label, 7.3, w) || w >= 72)
              const value = name && h >= (header ? 58 : 40) && fits(t.valueText, 6.6, w)
              return (
                <li
                  key={t.key}
                  aria-label={t.aria}
                  className="absolute overflow-hidden rounded-[4px] px-2 py-1.5 text-foreground transition-shadow duration-150 ease-out hover:ring-1 hover:ring-border-strong hover:ring-inset"
                  style={{ left: r.x + TILE_GAP, top: r.y + TILE_GAP, width: w, height: h, background: pale(g.harness, t.other ? 0.95 : 0.87) }}
                  {...bind(t.tip)}
                >
                  {header ? (
                    <div className="mb-0.5 flex items-center gap-1.5 text-[11px] leading-4 text-foreground/75">
                      <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: color }} />
                      <span className="truncate">
                        {harnessMeta(g.harness).label} · {g.valueText}
                        {fits(`${harnessMeta(g.harness).label} · ${g.valueText} · ${g.shareText}`, 6.4, w - 14) ? ` · ${g.shareText}` : ""}
                      </span>
                    </div>
                  ) : null}
                  {name ? <div className={`truncate leading-4 ${t.other ? "text-[12px] text-foreground/70" : "text-[13px] font-medium"}`}>{t.label}</div> : null}
                  {value ? <div className="truncate text-[12px] leading-4 text-foreground/70 tabular-nums">{t.valueText}</div> : null}
                </li>
              )
            })}
          </ul>
        )}
      </TipArea>
    </div>
  )
}
