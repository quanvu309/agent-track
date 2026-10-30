export type PanelStatus = "loading" | "empty" | "ready"

export function status<T>(data: T | undefined, isEmpty: (d: T) => boolean): PanelStatus {
  return data === undefined ? "loading" : isEmpty(data) ? "empty" : "ready"
}
