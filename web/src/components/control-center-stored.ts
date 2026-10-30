import { useCallback, useState } from "react"

/** State that survives a reload. Only a stored value that is one of `options` is trusted. */
export function useStored<V extends string>(key: string, options: readonly V[], fallback: V): [V, (v: V) => void] {
  const [value, setValue] = useState<V>(() => {
    try {
      const stored = localStorage.getItem(key)
      return options.find((o) => o === stored) ?? fallback
    } catch {
      return fallback
    }
  })
  const set = useCallback(
    (v: V) => {
      setValue(v)
      try {
        localStorage.setItem(key, v)
      } catch {
        return
      }
    },
    [key],
  )
  return [value, set]
}
