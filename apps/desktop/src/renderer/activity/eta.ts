import { useEffect, useState, type CSSProperties } from 'react'
import { etaView, type ActivityEta, type EtaView } from '@relay/protocol'
import type { ActivityItem } from '@evaos/chat-core/activity'
import './eta.css'

/** How often a visible estimate is read again; the fill glides between readings. */
export const ETA_TICK_MS = 5_000
/** A finished run's chip fills up, then fades: this long in all. */
export const ETA_LINGER_MS = 1_200

/** The activity id the host gives a helper: `helper:` and its transcript's absolute path. */
export const helperActivityId = (transcriptFile: string): string => `helper:${transcriptFile}`

/** A subagent chip's transcript, from the chat's session file and the subagent's file name. */
export const subagentTranscriptFile = (sessionFile: string, file: string): string =>
  `${sessionFile.replace(/\.jsonl$/, '')}/${file}`

/** An item that is running with an estimate: the only kind that draws a fill. */
export const hasEta = (item: ActivityItem): boolean =>
  item.status === 'working' && item.eta !== undefined

/** The running item `id` with an estimate in the host's list, if there is one. */
export function etaItem(items: readonly ActivityItem[], id: string): ActivityItem | undefined {
  return items.find((i) => i.id === id && hasEta(i))
}

export type EtaTone = 'solid' | 'striped' | 'overrunning'
/** `chip`: the whole chip fades after filling; `fill`: only the fill does (the chip stays). */
export type EtaLeaving = 'chip' | 'fill'

export interface EtaFill {
  view: EtaView
  tone: EtaTone
  /** 0..1; a finished run's is 1. */
  fraction: number
  leaving: EtaLeaving | null
}

/** What one badge draws for an estimate at `now`. A leaving badge fills up before it fades. */
export function etaFill(eta: ActivityEta, now: number, leaving: EtaLeaving | null = null): EtaFill {
  const view = etaView(eta, now)
  const tone: EtaTone =
    view.state === 'overrunning' ? 'overrunning' : view.confident ? 'solid' : 'striped'
  return { view, tone, fraction: leaving === null ? view.fraction : 1, leaving }
}

/** The attributes and custom properties the fill stylesheet (`eta.css`) reads; add class `eva-eta`. */
export function etaProps(
  fill: EtaFill,
  color?: string,
): { 'data-eta': EtaTone; 'data-eta-leaving'?: EtaLeaving; style: CSSProperties } {
  const style: Record<string, string> = {
    '--eta-fraction': String(Math.round(fill.fraction * 1000) / 1000),
  }
  if (color !== undefined) style['--eva-eta-agent-c'] = color
  return {
    'data-eta': fill.tone,
    ...(fill.leaving === null ? {} : { 'data-eta-leaving': fill.leaving }),
    style: style as CSSProperties,
  }
}

/** A row's trailing time while it has an estimate ("12m left"); null when the age says it better. */
export const etaTrailing = (view: EtaView): string | null =>
  view.short === null ? null : `${view.short} left`

/** What `lingerStep` carries: the running items it saw last, and those that just left. */
export interface LingerState<T> {
  known: readonly T[]
  leaving: readonly { item: T; since: number }[]
}
export const lingerStart = { known: [], leaving: [] } as const

/**
 * Items that were running with an estimate and are gone from `current` stay on as `leaving` for
 * `ETA_LINGER_MS`, so their badge can fill and fade instead of vanishing. One that comes back
 * (a fresh run under the same id) stops leaving.
 */
export function lingerStep<T extends { id: string }>(
  state: LingerState<T>,
  current: readonly T[],
  now: number,
): LingerState<T> {
  const here = new Set(current.map((i) => i.id))
  const leaving = state.leaving.filter((l) => !here.has(l.item.id) && now - l.since < ETA_LINGER_MS)
  const held = new Set(leaving.map((l) => l.item.id))
  for (const item of state.known) {
    if (!here.has(item.id) && !held.has(item.id)) leaving.push({ item, since: now })
  }
  return { known: current, leaving }
}

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

/**
 * The running items with an estimate that left `items` a moment ago. `items` must keep its
 * identity between renders (memoize it), or the follow-up effect never settles.
 */
export function useEtaLinger<T extends { id: string }>(items: readonly T[]): readonly T[] {
  const [state, setState] = useState<LingerState<T>>(lingerStart)
  useEffect(() => {
    setState((s) => lingerStep(s, items, Date.now()))
  }, [items])
  useEffect(() => {
    if (state.leaving.length === 0) return undefined
    const end = Math.min(...state.leaving.map((l) => l.since)) + ETA_LINGER_MS
    const t = setTimeout(
      () => setState((s) => lingerStep(s, items, Date.now())),
      Math.max(0, end - Date.now()) + 10,
    )
    return () => clearTimeout(t)
  }, [state, items])
  const here = new Set(items.map((i) => i.id))
  return state.leaving.filter((l) => !here.has(l.item.id)).map((l) => l.item)
}

/** One row's fill: its estimate read on the shared ticker; null without an estimate. */
export function useEtaFill(item: ActivityItem | undefined): EtaFill | null {
  const eta = item !== undefined && hasEta(item) ? item.eta : undefined
  const now = useEtaNow(eta !== undefined)
  return eta === undefined ? null : etaFill(eta, now)
}
