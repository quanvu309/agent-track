import { LayoutList, type LucideIcon, MemoryStick, Radar, TrendingUp, Wrench } from "lucide-react"

export const VIEWS = [
  { id: "now", label: "Control center", short: "Control", icon: Radar },
  { id: "trends", label: "Trends", short: "Trends", icon: TrendingUp },
  { id: "usage", label: "Usage", short: "Usage", icon: Wrench },
  { id: "sessions", label: "Sessions", short: "Sessions", icon: LayoutList },
  { id: "machine", label: "Machine", short: "Machine", icon: MemoryStick },
] as const satisfies readonly { id: string; label: string; short: string; icon: LucideIcon }[]

export type ViewId = (typeof VIEWS)[number]["id"]

export function viewFromUrl(): ViewId {
  const v = new URLSearchParams(location.search).get("view")
  return VIEWS.find((x) => x.id === v)?.id ?? "now"
}

/** Keeps the view in the query string so the `#session=` hash stays free for the drill-down link. */
export function writeViewToUrl(view: ViewId) {
  const params = new URLSearchParams(location.search)
  if (view === "now") params.delete("view")
  else params.set("view", view)
  const search = params.toString()
  history.replaceState(null, "", location.pathname + (search ? `?${search}` : "") + location.hash)
}
