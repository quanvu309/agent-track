import { useEffect, useRef, useState } from "react"

import { type Parser, parseIngest, parseSummary } from "./types"

async function request<T>(path: string, parse: Parser<T>, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) throw new Error(`${path}: ${res.status}`)
  return parse(await res.json(), path)
}

export type Loaded<T> = { data: T | undefined; error: string | null; loading: boolean }

/** Fetches `url` whenever it or `refreshKey` changes, and every `pollMs` if given. A null url keeps the last result. */
export function useApi<T>(url: string | null, parse: Parser<T>, refreshKey = 0, pollMs?: number): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ data: undefined, error: null, loading: url !== null })

  useEffect(() => {
    if (url === null) return
    let ctrl = new AbortController()
    const load = async () => {
      ctrl.abort()
      ctrl = new AbortController()
      const { signal } = ctrl
      setState((s) => ({ ...s, loading: true }))
      try {
        const data = await request(url, parse, { signal })
        if (!signal.aborted) setState({ data, error: null, loading: false })
      } catch (err) {
        if (!signal.aborted) setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err), loading: false }))
      }
    }
    load()
    const timer = pollMs ? setInterval(load, pollMs) : undefined
    return () => {
      clearInterval(timer)
      ctrl.abort()
    }
  }, [url, parse, refreshKey, pollMs])

  return state
}

export function runIngest() {
  return request("/api/ingest", parseIngest, { method: "POST" })
}

/** Polls the cheap summary and calls `onChange` when a new ingest finished or one is running. */
export function useIngestWatch(lastIngest: string | null | undefined, onChange: () => void, everyMs = 30_000) {
  const seen = useRef(lastIngest)
  const callback = useRef(onChange)
  useEffect(() => {
    seen.current = lastIngest
    callback.current = onChange
  })
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const sm = await request("/api/summary", parseSummary)
        if (sm.last_ingest !== seen.current || sm.ingesting) callback.current()
      } catch {
        // The next tick retries; the dashboard keeps its last data meanwhile.
      }
    }, everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
}
