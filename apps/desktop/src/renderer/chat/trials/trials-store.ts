import { useMemo, useRef } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { notifications } from '@mantine/notifications'
import type { TrialCardView, TrialPickValue, TrialSwitchView, TrialsView } from '@evaos/contract'
import { invoke, on } from '../../ipc'
import type { LogItem } from '../ChatLog'

/**
 * Taste agents' trial cards and model switch messages (trial mode), as main last heard them from
 * the host: every chat's, each chat's log shows its own by thread. A card or message that did not
 * change keeps its object, so a push for one card never redraws the others.
 */
interface TrialsState {
  /** The host takes picks and undos now. */
  up: boolean
  trials: readonly TrialCardView[]
  switches: readonly TrialSwitchView[]
}

export const trialsStore = createStore<TrialsState>(() => ({ up: false, trials: [], switches: [] }))

export function useTrials<T>(selector: (s: TrialsState) => T): T {
  return useStore(trialsStore, selector)
}

/** `after`, with each entry equal to one of `before` (same id, same content) as that object. */
function keepSame<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
): readonly T[] {
  const old = new Map(before.map((x) => [x.id, x]))
  let same = before.length === after.length
  const out = after.map((x, i) => {
    const o = old.get(x.id)
    const kept = o !== undefined && JSON.stringify(o) === JSON.stringify(x) ? o : x
    if (kept !== before[i]) same = false
    return kept
  })
  return same ? before : out
}

function applyView(v: TrialsView): void {
  trialsStore.setState((s) => ({
    up: v.up,
    trials: keepSame(s.trials, v.trials),
    switches: keepSame(s.switches, v.switches),
  }))
}

/** Follows main's pushes of the host's cards and messages, and asks for them now. */
export function startTrials(): () => void {
  const off = on('trials.changed', applyView)
  void invoke('trials.get', {}).then((r) => {
    if (r.ok) applyView(r.value)
  })
  return off
}

/** A card or a switch message as a row of a chat's log, placed by when it came (`at`, ms). */
export type TrialRow =
  | { kind: 'trial'; at: number; item: TrialCardView }
  | { kind: 'trialSwitch'; at: number; item: TrialSwitchView }

const NONE: readonly TrialRow[] = []

/**
 * The cards and switch messages of chat `thread` (`assistant:<id>` or `session:<id>`), oldest
 * first; the same array while none of them changed, so the log does not re-lay out for another
 * chat's push.
 */
export function useThreadTrialRows(thread: string | null): readonly TrialRow[] {
  const trials = useTrials((s) => s.trials)
  const switches = useTrials((s) => s.switches)
  const last = useRef(NONE)
  return useMemo(() => {
    const rows: TrialRow[] =
      thread === null
        ? []
        : [
            ...trials
              .filter((t) => t.thread === thread)
              .map((item): TrialRow => ({ kind: 'trial', at: item.at, item })),
            ...switches
              .filter((s) => s.thread === thread)
              .map((item): TrialRow => ({ kind: 'trialSwitch', at: item.at, item })),
          ].sort((a, b) => a.at - b.at)
    const prev = last.current
    if (rows.length !== prev.length || rows.some((r, i) => r.item !== prev[i]!.item))
      last.current = rows.length === 0 ? NONE : rows
    return last.current
  }, [thread, trials, switches])
}

/**
 * The log's rows with the trial rows in their places: each goes before the first message stamped
 * after it, so a card sits where its request came in and later replies come below it. Unstamped
 * rows (tool calls, the streaming reply) never split them from what came before.
 */
export function placeTrialRows(items: LogItem[], rows: readonly TrialRow[]): LogItem[] {
  if (rows.length === 0) return items
  const out: LogItem[] = []
  let next = 0
  for (const it of items) {
    const at = it.kind === 'message' ? it.m.at : undefined
    if (at !== undefined) while (next < rows.length && rows[next]!.at < at) out.push(rows[next++]!)
    out.push(it)
  }
  while (next < rows.length) out.push(rows[next++]!)
  return out
}

export const PICK_FAILED = "Couldn't send your pick."
export const UNDO_FAILED = "Couldn't undo the switch."

/** Sends Isaac's pick on card `trial`; true once the host recorded it, else a toast says why. */
export async function pickTrial(trial: string, pick: TrialPickValue): Promise<boolean> {
  const r = await invoke('trials.pick', { trial, pick })
  if (r.ok && r.value.ok) return true
  const why = r.ok ? r.value.error : r.error.message
  notifications.show({ color: 'red', message: why ? `${PICK_FAILED} ${why}` : PICK_FAILED })
  return false
}

/** Undoes switch `id`; true once the host took it, else a toast says why. */
export async function undoSwitch(id: string): Promise<boolean> {
  const r = await invoke('trials.undo', { switch: id })
  if (r.ok && r.value.ok) return true
  const why = r.ok ? r.value.error : r.error.message
  notifications.show({ color: 'red', message: why ? `${UNDO_FAILED} ${why}` : UNDO_FAILED })
  return false
}
