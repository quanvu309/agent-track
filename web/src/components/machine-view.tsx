import { useEffect, useState, useSyncExternalStore } from "react"

import { BurnCard, DayCard } from "@/components/machine-burn"
import { HistoryCard, type Window } from "@/components/machine-history"
import { ProcsCard } from "@/components/machine-procs"
import { StatusCard } from "@/components/machine-status"
import { useApi } from "@/lib/api"
import { shiftDay } from "@/lib/format"
import { BURN_URL } from "@/lib/machine-burn"
import { parseBurn, parseMachine, parseToday } from "@/lib/types"

const POLL_MS = 15_000

function usePageVisible() {
  return useSyncExternalStore(
    (onChange) => {
      document.addEventListener("visibilitychange", onChange)
      return () => document.removeEventListener("visibilitychange", onChange)
    },
    () => document.visibilityState === "visible",
  )
}

/** Mounted only while the Machine view is open, so nothing here fetches on other views or in a hidden tab. */
export default function MachineView({ onError }: { onError: (message: string | null) => void }) {
  const visible = usePageVisible()
  const [span, setSpan] = useState<Window>("60")
  const machine = useApi(visible ? `/api/machine?minutes=${span}` : null, parseMachine, 0, POLL_MS)
  const burn = useApi(visible ? BURN_URL : null, parseBurn, 0, POLL_MS)
  const today = useApi(visible ? "/api/today" : null, parseToday, 0, 60_000)
  const day = today.data?.day
  const yesterday = useApi(day ? `/api/today?day=${shiftDay(day, -1)}` : null, parseToday)

  const error = [machine, burn, today, yesterday].find((s) => s.error)?.error ?? null
  useEffect(() => onError(error), [error, onError])
  useEffect(() => () => onError(null), [onError])

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-5">
      <StatusCard now={machine.data?.now} className="lg:col-start-1 lg:row-start-1" />
      <BurnCard burn={burn.data} className="lg:col-start-2 lg:row-start-1" />
      <DayCard today={today.data} yesterday={yesterday.data} className="lg:col-start-2 lg:row-start-2 lg:self-start" />
      <HistoryCard machine={machine.data} span={span} onSpan={setSpan} className="lg:col-start-1 lg:row-span-2 lg:row-start-2 lg:self-start" />
      <ProcsCard now={machine.data?.now} className="lg:col-start-2 lg:row-start-3 lg:self-start" />
    </div>
  )
}
