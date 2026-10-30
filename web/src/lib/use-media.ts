import { useSyncExternalStore } from "react"

export const WIDE = "(min-width: 1024px)"

export function useMedia(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const mq = matchMedia(query)
      mq.addEventListener("change", onChange)
      return () => mq.removeEventListener("change", onChange)
    },
    () => matchMedia(query).matches,
  )
}
