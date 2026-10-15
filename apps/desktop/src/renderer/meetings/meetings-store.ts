import { useEffect } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { MeetingSummary, Proposal } from '@evaos/contract'
import { setMeetingTitles } from '../eva/names-store'
import { invoke } from '../ipc'
import { registerReloader } from '../reload/reload'

export interface MeetingDigest {
  recentCount: number
  waiting: Array<{ stem: string; title: string; proposal: Proposal }>
  out: Array<{ text: string; date: string | null; stem: string; title: string }>
  decisions: Array<{ text: string; stem: string; title: string }>
}

export interface MeetingProtocol {
  attendees: string[]
  attendeesSource: string | null
  summary: string[]
  decisions: string[]
  questions: string[]
  transcript: Array<{ time: string; speaker: string | null; text: string }>
}

export interface MeetingDetail {
  meeting:
    | (MeetingSummary & {
        proposals: Proposal[]
        memorized: Array<{ kind: string; text: string; p: number | null }>
      })
    | null
  notes: 'ok' | 'missing' | 'none'
  protocol: MeetingProtocol | null
}

const EMPTY_DIGEST: MeetingDigest = { recentCount: 0, waiting: [], out: [], decisions: [] }

export interface MeetingsState {
  list: MeetingSummary[] | null
  digest: MeetingDigest
  now: number
  loading: boolean
  error: boolean
  details: Record<string, MeetingDetail>
}

const initial = (): MeetingsState => ({
  list: null,
  digest: EMPTY_DIGEST,
  now: Date.now(),
  loading: true,
  error: false,
  details: {},
})

export const meetingsStore = createStore<MeetingsState>(initial)

export function useMeetings<T>(selector: (s: MeetingsState) => T): T {
  return useStore(meetingsStore, selector)
}

let inflight: Promise<void> | null = null
let queued = false

async function runOnce(): Promise<void> {
  try {
    const r = await invoke('meetings.list', {})
    if (r.ok) {
      meetingsStore.setState({
        list: r.value.meetings,
        digest: r.value.digest,
        now: r.value.now,
        error: false,
        loading: false,
      })
      setMeetingTitles(Object.fromEntries(r.value.meetings.map((m) => [m.stem, m.title])))
    } else meetingsStore.setState({ error: true, loading: false })
  } catch {
    meetingsStore.setState({ error: true, loading: false })
  }
}

/** One request in flight; triggers during flight collapse into exactly one follow-up. */
export function loadMeetings(): Promise<void> {
  if (inflight) {
    queued = true
    return inflight
  }
  inflight = (async () => {
    try {
      do {
        queued = false
        await runOnce()
      } while (queued)
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** Fetches one meeting and caches it by stem; a repeat call refreshes the cache. */
export async function loadMeeting(stem: string): Promise<void> {
  try {
    const r = await invoke('meetings.get', { stem })
    if (r.ok) {
      meetingsStore.setState((s) => ({ details: { ...s.details, [stem]: r.value } }))
    }
  } catch {
    // keep the cached copy
  }
}

async function reloadAllMeetings(): Promise<void> {
  await Promise.all([
    loadMeetings(),
    ...Object.keys(meetingsStore.getState().details).map((stem) => loadMeeting(stem)),
  ])
}

let mounted = 0
let off: (() => void) | null = null

/** Ref-counted: the 'meetings' reloader is registered while any meetings surface is mounted. */
export function mountMeetings(): () => void {
  if (mounted++ === 0) off = registerReloader('meetings', reloadAllMeetings)
  void loadMeetings()
  let done = false
  return () => {
    if (done) return
    done = true
    if (--mounted === 0) {
      off?.()
      off = null
    }
  }
}

export function useMeetingsSurface(): void {
  useEffect(() => mountMeetings(), [])
}

export function resetMeetingsForTests(): void {
  inflight = null
  queued = false
  off?.()
  off = null
  mounted = 0
  meetingsStore.setState(initial(), true)
}
