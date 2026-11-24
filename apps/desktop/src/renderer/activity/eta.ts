import { useEffect, useState } from 'react'
import { etaView, type EtaView } from '@relay/protocol'
import type { ActivityItem } from '@evaos/chat-core/activity'

/** How often a visible estimate is read again. */
export const ETA_TICK_MS = 5_000

/** The activity id the host gives a helper: `helper:` and its transcript's absolute path. */
export const helperActivityId = (transcriptFile: string): string => `helper:${transcriptFile}`

/** A subagent chip's transcript, from the chat's session file and the subagent's file name. */
export const subagentTranscriptFile = (sessionFile: string, file: string): string =>
  `${sessionFile.replace(/\.jsonl$/, '')}/${file}`

/** An item that is running with an estimate. */
export const hasEta = (item: ActivityItem): boolean =>
  item.status === 'working' && item.eta !== undefined

/** The running item `id` with an estimate in the host's list, if there is one. */
export function etaItem(items: readonly ActivityItem[], id: string): ActivityItem | undefined {
  return items.find((i) => i.id === id && hasEta(i))
}

/** A row's trailing time while it has an estimate ("12m left"); null when the age says it better. */
export const etaTrailing = (view: EtaView): string | null =>
  view.short === null ? null : `${view.short} left`

type Tick = (now: number) => void
const listeners = new Set<Tick>()
let timer: number | null = null

function subscribe(tick: Tick): () => void {
  listeners.add(tick)
  timer ??= window.setInterval(() => {
    const now = Date.now()
    for (const l of listeners) l(now)
  }, ETA_TICK_MS)
  return () => {
    listeners.delete(tick)
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
  }
}

/** The time, re-read every few seconds while `enabled`; every caller shares one interval. */
export function useEtaNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return undefined
    setNow(Date.now())
    return subscribe(setNow)
  }, [enabled])
  return now
}

/** One row's estimate read on the shared ticker; null without an estimate. */
export function useEtaView(item: ActivityItem | undefined): EtaView | null {
  const eta = item !== undefined && hasEta(item) ? item.eta : undefined
  const now = useEtaNow(eta !== undefined)
  return eta === undefined ? null : etaView(eta, now)
}
