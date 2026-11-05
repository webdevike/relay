import { useEffect, useState } from 'react'
import { notifications } from '@mantine/notifications'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { applyLiveLines } from '@relay/protocol'
import type {
  MeetingsChange,
  MeetingSummary,
  Proposal,
  Recording,
  RecordingView,
} from '@evaos/contract'
import { setMeetingTitles, workspaceTitle } from '../eva/names-store'
import { invoke, on } from '../ipc'
import { registerReloader, reloadAll } from '../reload/reload'

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
  /** Relay's recordings on the host, newest first. */
  recordings: Recording[]
  digest: MeetingDigest
  now: number
  loading: boolean
  error: boolean
  details: Record<string, MeetingDetail>
  /** Recordings' pages by id, kept current by the host's pushes. */
  views: Record<string, RecordingView>
}

const initial = (): MeetingsState => ({
  list: null,
  recordings: [],
  digest: EMPTY_DIGEST,
  now: Date.now(),
  loading: true,
  error: false,
  details: {},
  views: {},
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
        recordings: r.value.recordings,
        digest: r.value.digest,
        now: r.value.now,
        error: false,
        loading: false,
      })
      setMeetingTitles({
        ...Object.fromEntries(r.value.meetings.map((m) => [m.stem, m.title])),
        ...Object.fromEntries(r.value.recordings.map((x) => [x.id, recordingTitle(x)])),
      })
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

/** "Weekly Engineering Sync", or "Microsoft Teams call" for an untitled one. */
export function recordingTitle(r: Pick<Recording, 'title' | 'app'>): string {
  return r.title ?? `${r.app} call`
}

/** A recording's id (the helper's UUID) rather than a record's stem. */
export function isRecordingId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
}

/** Fetches one recording's page from the host; later changes arrive as pushes. */
export async function loadRecording(id: string): Promise<string | null> {
  try {
    const r = await invoke('meetings.open', { id })
    if (!r.ok) return r.error.message
    meetingsStore.setState((s) => ({ views: { ...s.views, [id]: r.value } }))
    return null
  } catch {
    return 'The Relay Host did not answer.'
  }
}

/** A question to Astra about the recording; resolves with the error line, or null. */
export async function askAboutMeeting(id: string, question: string): Promise<string | null> {
  const r = await invoke('meetings.ask', { id, question }).catch(() => null)
  if (r === null) return 'The Relay Host did not answer.'
  if (!r.ok) return r.error.message
  meetingsStore.setState((s) => {
    const v = s.views[id]
    return v ? { views: { ...s.views, [id]: { ...v, astra: r.value } } } : {}
  })
  return null
}

/** Applies one host push to the list and the open pages. */
export function applyMeetingsChange(c: MeetingsChange): void {
  if (c.kind === 'list') {
    void loadMeetings()
    return
  }
  meetingsStore.setState((s) => {
    if (c.kind === 'recording') {
      const others = s.recordings.filter((x) => x.id !== c.recording.id)
      const recordings = [c.recording, ...others].sort((a, b) => b.startedAt - a.startedAt)
      const v = s.views[c.recording.id]
      return {
        recordings,
        ...(v ? { views: { ...s.views, [c.recording.id]: { ...v, recording: c.recording } } } : {}),
      }
    }
    const v = s.views[c.id]
    if (!v) return {}
    const next =
      c.kind === 'live'
        ? { ...v, lines: applyLiveLines(v.lines, c.upsert) }
        : { ...v, astra: c.astra }
    return { views: { ...s.views, [c.id]: next } }
  })
  // Notes are written when the recording reaches done: read the page again for them.
  if (c.kind === 'recording' && c.recording.stage === 'done') {
    const v = meetingsStore.getState().views[c.recording.id]
    if (v && v.notes === null) void loadRecording(c.recording.id)
  }
}

export type ProposalResult = { ok: true } | { ok: false; code: string; message: string }

function workspaceName(tag: string): string {
  return tag === 'eva' ? 'Eva' : (workspaceTitle(tag) ?? tag)
}

async function afterWrite(stem: string): Promise<void> {
  await Promise.all([loadMeeting(stem), loadMeetings()])
  void reloadAll()
}

async function act(
  stem: string,
  run: () =>
    | ReturnType<typeof invoke<'meetings.accept'>>
    | ReturnType<typeof invoke<'meetings.dismiss'>>,
  toast: (value: never) => string,
): Promise<ProposalResult> {
  let r
  try {
    r = await run()
  } catch {
    return { ok: false, code: 'internal', message: 'The meeting could not be updated.' }
  }
  if (!r.ok) return { ok: false, code: r.error.code, message: r.error.message }
  notifications.show({ message: toast(r.value as never), color: 'green', autoClose: 4000 })
  await afterWrite(stem)
  return { ok: true }
}

/** Accept a proposal as a todo; resolves with a result the row renders. */
export function acceptProposal(stem: string, proposalId: string): Promise<ProposalResult> {
  return act(
    stem,
    () => invoke('meetings.accept', { stem, proposalId }),
    (v: { todoId: string; tag: string }) => `Added ${v.todoId} to ${workspaceName(v.tag)}.`,
  )
}

export function dismissProposal(stem: string, proposalId: string): Promise<ProposalResult> {
  return act(
    stem,
    () => invoke('meetings.dismiss', { stem, proposalId }),
    () => 'Dismissed.',
  )
}

async function reloadAllMeetings(): Promise<void> {
  const s = meetingsStore.getState()
  await Promise.all([
    loadMeetings(),
    ...Object.keys(s.details).map((stem) => loadMeeting(stem)),
    ...Object.keys(s.views).map((id) => loadRecording(id)),
  ])
}

let mounted = 0
let off: (() => void) | null = null
let offChanges: (() => void) | null = null

/** Ref-counted: the 'meetings' reloader and the host's pushes are on while any meetings surface is mounted. */
export function mountMeetings(): () => void {
  if (mounted++ === 0) {
    off = registerReloader('meetings', reloadAllMeetings, ['meetings'])
    offChanges = on('meetings.changed', applyMeetingsChange)
  }
  void loadMeetings()
  let done = false
  return () => {
    if (done) return
    done = true
    if (--mounted === 0) {
      off?.()
      off = null
      offChanges?.()
      offChanges = null
    }
  }
}

export function useMeetingsSurface(): void {
  useEffect(() => mountMeetings(), [])
}

/** The clock, re-read every second while `on` (a live recording's elapsed time). */
export function useTicker(on: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

export function resetMeetingsForTests(): void {
  inflight = null
  queued = false
  off?.()
  off = null
  offChanges?.()
  offChanges = null
  mounted = 0
  meetingsStore.setState(initial(), true)
}
