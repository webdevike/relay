import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ID = '6f1c2b8e-0d1a-4c55-9a51-3b2f0c7d9e11'
const listeners = vi.hoisted(() => new Map<string, (p: unknown) => void>())
const invoke = vi.hoisted(() => vi.fn())
const askInChat = vi.hoisted(() => vi.fn(async () => null))
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: (ch: string, cb: (p: unknown) => void) => {
    listeners.set(ch, cb)
    return () => listeners.delete(ch)
  },
}))
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }))
vi.mock('../navigation/navigate', () => ({ openPlace: vi.fn(), setNavigator: () => {} }))
vi.mock('./meeting-chat', () => ({ askInChat: (...a: unknown[]) => askInChat(...(a as [])) }))

import { resetReloadForTests } from '../reload/reload'
import { MeetingTab } from './MeetingTab'
import { resetMeetingsForTests } from './meetings-store'

const MIN = 60_000
const startedAt = Date.now() - 56.5 * MIN
const recording = (over = {}) => ({
  id: ID,
  app: 'Teams',
  title: 'Developer Sync',
  startedAt,
  endedAt: null,
  device: 'Isaac MacBook',
  stage: 'recording',
  health: 'ok',
  healthDetail: '',
  error: null,
  shadow: false,
  stem: null,
  seconds: 3400,
  assistant: 'astra',
  ...over,
})
const SAID: Array<[number, string, string]> = [
  [14, 'Priya', 'I can look at the staging dry run after lunch.'],
  [22, 'Todd', "We'll ship the release Thursday if QA is clean."],
  [28, 'Isaac', 'Yeah, makes sense.'],
  [35, 'Todd', 'Isaac, can you take the dashboard?'],
  [51, 'Chris', 'Looks like three accounts failed on the same step.'],
]
const LINES = SAID.map(([min, speaker, text], i) => ({
  id: `l${i}`,
  track: speaker === 'Isaac' ? 'mic' : 'app',
  speaker,
  startMs: min * MIN,
  endMs: min * MIN + 4000,
  text,
  final: true,
}))
// What the host's small model found in those lines.
const MOMENTS = [
  {
    id: 'km1',
    kind: 'action',
    atMs: 14 * MIN,
    lineId: 'l0',
    speaker: 'Priya',
    text: 'Priya looks at the staging dry run after lunch',
    shot: null,
  },
  {
    id: 'km2',
    kind: 'decision',
    atMs: 22 * MIN,
    lineId: 'l1',
    speaker: 'Todd',
    text: 'Ship the release Thursday if QA is clean',
    shot: 0,
  },
  {
    id: 'km3',
    kind: 'ask',
    atMs: 35 * MIN,
    lineId: 'l3',
    speaker: 'Todd',
    text: 'Isaac to take the dashboard',
    shot: null,
  },
  {
    id: 'km4',
    kind: 'claim',
    atMs: 51 * MIN,
    lineId: 'l4',
    speaker: 'Chris',
    text: 'Three accounts failed on the same step',
    shot: 1,
  },
]
const SHOTS = [0, 1].map((n) => ({
  n,
  atMs: (21 + n * 29) * MIN,
  src: `/meetings/shots/${ID}/tok/${n}`,
  w: 1600,
  h: 900,
  line:
    n === 0 ? "Todd: We'll ship the release Thursday" : 'Chris: Looks like three accounts failed',
  ocr: n === 0 ? 'Release checklist\nQA sign-off' : 'Provisioning failures\nacct-17 timeout',
}))
let lines: unknown[] = LINES
let notes: unknown = null
let moments: unknown[] = MOMENTS
let shots: unknown[] = SHOTS
let rec = recording()

const wrap = () =>
  render(
    <MantineProvider>
      <MeetingTab id={ID} />
    </MantineProvider>,
  )
const tab = () => screen.getByTestId('meeting-tab')
const view = () => screen.getByTestId('meeting-tab-view')
const push = (c: unknown) => act(() => listeners.get('meetings.changed')?.(c))

beforeEach(() => {
  invoke.mockReset()
  askInChat.mockClear()
  listeners.clear()
  resetReloadForTests()
  resetMeetingsForTests()
  lines = LINES
  notes = null
  moments = MOMENTS
  shots = SHOTS
  rec = recording()
  invoke.mockImplementation(async (ch: string) => {
    if (ch === 'meetings.list')
      return {
        ok: true,
        value: {
          now: Date.now(),
          meetings: [],
          recordings: [rec],
          digest: { recentCount: 0, waiting: [], out: [], decisions: [] },
        },
      }
    if (ch === 'meetings.open')
      return { ok: true, value: { recording: rec, lines, astra: null, notes, moments, shots } }
    if (ch === 'meetings.stop') return { ok: true, value: { stopped: true } }
    return { ok: true, value: {} }
  })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('MeetingTab on the call', () => {
  it('leads with Now: the key moments newest first, then the shared screen', async () => {
    wrap()
    const now = await screen.findByTestId('meeting-now')
    const tabs = within(screen.getByTestId('meeting-tabs')).getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Now', 'Transcript', 'Moments'])
    expect(screen.getByTestId('meeting-tab-now')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('meeting-tab-when')).toHaveTextContent('56 min')
    expect(tab()).toHaveTextContent('Teams·Live·56 min')
    expect(screen.getByTestId('meeting-end')).toHaveTextContent('End meeting')
    // Each: its time, the line, its kind and who said it. Isaac answered nothing after 35:00.
    const rows = within(now).getAllByTestId('meeting-moment')
    expect(rows.map((m) => m.dataset.kind)).toEqual(['claim', 'ask', 'decision', 'action'])
    expect(rows[0]).toHaveTextContent('51:00Three accounts failed on the same stepClaim · Chris')
    expect(rows[1]).toHaveTextContent('Isaac to take the dashboardAsks you · Todd · no reply yet')
    expect(rows[1]).toHaveAttribute('data-open', 'true')
    expect(rows[2]).toHaveAttribute('data-open', 'false')
    // Two moments refer to a snapshot.
    expect(within(now).getAllByTestId('meeting-moment-shot')).toHaveLength(2)
    const strip = screen.getAllByTestId('meeting-shot')
    expect(strip.map((s) => s.textContent)).toEqual(['21:00', '50:00'])
    expect(strip[0]!.querySelector('img')!.getAttribute('src')).toBe(
      `relay-media://media/?src=${encodeURIComponent(`/meetings/shots/${ID}/tok/0`)}`,
    )
    expect(screen.queryByTestId('meeting-share-off')).toBeNull()
  })

  it('shows at most eight key moments on Now and follows the pushed list', async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      ...MOMENTS[0]!,
      id: `k${i}`,
      atMs: i * MIN,
      text: `Moment ${i}`,
    }))
    moments = many
    wrap()
    await waitFor(() => expect(screen.getAllByTestId('meeting-moment')).toHaveLength(8))
    expect(screen.getAllByTestId('meeting-moment')[0]).toHaveTextContent('Moment 10')
    push({
      kind: 'moments',
      id: ID,
      moments: [...many, { ...many[0]!, id: 'new', text: 'Newest' }],
    })
    expect(screen.getAllByTestId('meeting-moment')[0]).toHaveTextContent('Newest')
    fireEvent.click(screen.getByTestId('meeting-tab-moments'))
    expect(screen.getAllByTestId('meeting-moment')).toHaveLength(12)
  })

  it('says where key moments will show, and adds a pushed snapshot to the strip', async () => {
    moments = []
    shots = []
    wrap()
    expect(await screen.findByTestId('meeting-now-empty')).toHaveTextContent(
      'Key moments show up here as the call goes',
    )
    expect(screen.queryByTestId('meeting-shots')).toBeNull()
    push({ kind: 'shot', id: ID, shot: SHOTS[0] })
    expect(screen.getAllByTestId('meeting-shot')).toHaveLength(1)
  })

  it('opens a snapshot larger with its time, line and text, from the strip or a moment', async () => {
    wrap()
    fireEvent.click((await screen.findAllByTestId('meeting-shot'))[1]!)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Shared screen at 50:00')
    expect(dialog).toHaveTextContent('Chris: Looks like three accounts failed')
    expect(within(dialog).getByTestId('meeting-shot-ocr')).toHaveTextContent('acct-17 timeout')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // The decision at 22:00 refers to the first snapshot.
    fireEvent.click(screen.getAllByTestId('meeting-moment-shot')[1]!)
    expect(await screen.findByRole('dialog')).toHaveTextContent('Shared screen at 21:00')
  })

  it('says in one line when Screen Recording is missing', async () => {
    rec = recording({ share: 'no-permission' })
    wrap()
    expect(await screen.findByTestId('meeting-share-off')).toHaveTextContent(
      'Screen snapshots are off: allow Screen Recording for Relay in System Settings.',
    )
  })

  it('lists every key moment newest first', async () => {
    wrap()
    fireEvent.click(await screen.findByTestId('meeting-tab-moments'))
    const kinds = screen.getAllByTestId('meeting-moment').map((m) => m.dataset.kind)
    expect(kinds).toEqual(['claim', 'ask', 'decision', 'action'])
  })

  it('says "Nothing yet." when the call has no key moments', async () => {
    moments = []
    wrap()
    fireEvent.click(await screen.findByTestId('meeting-tab-moments'))
    expect(view()).toHaveTextContent('Nothing yet.')
  })

  it('jumps from a moment to its transcript row and lights it up for a while', async () => {
    wrap()
    const todd = (await screen.findAllByTestId('meeting-moment'))[1]!
    vi.useFakeTimers()
    fireEvent.click(todd)
    expect(screen.getByTestId('meeting-tab-transcript')).toHaveAttribute('aria-selected', 'true')
    const row = screen.getAllByTestId('meeting-row').find((r) => r.dataset.rowId === 'l3')!
    expect(row).toHaveAttribute('data-lit', 'true')
    // Following pauses on the jump.
    expect(screen.getByTestId('meeting-jump-live')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(2300))
    expect(row).toHaveAttribute('data-lit', 'false')
  })

  it('pauses following when scrolled up, resumes at the bottom or on Jump to live', async () => {
    wrap()
    fireEvent.click(await screen.findByTestId('meeting-tab-transcript'))
    await waitFor(() => expect(screen.getAllByTestId('meeting-row')).toHaveLength(5))
    const el = view()
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(el, 'scrollTop', { value: 700, writable: true, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true })
    expect(screen.queryByTestId('meeting-jump-live')).toBeNull()
    el.scrollTop = 200
    fireEvent.scroll(el)
    fireEvent.click(screen.getByTestId('meeting-jump-live'))
    expect(screen.queryByTestId('meeting-jump-live')).toBeNull()
    el.scrollTop = 100
    fireEvent.scroll(el)
    expect(screen.getByTestId('meeting-jump-live')).toBeInTheDocument()
    el.scrollTop = 690
    fireEvent.scroll(el)
    expect(screen.queryByTestId('meeting-jump-live')).toBeNull()
    // Mic lines read "You", in the accent like rows that put a question to Isaac.
    const who = screen.getAllByTestId('meeting-row').map((r) => r.querySelector('[data-you]')!)
    expect(who.map((w) => [w.textContent, w.getAttribute('data-you')])).toEqual([
      ['Priya', 'false'],
      ['Todd', 'false'],
      ['You', 'true'],
      ['Todd', 'true'],
      ['Chris', 'false'],
    ])
  })

  it('posts an Ask menu item into the owning chat and shows no answer here', async () => {
    wrap()
    fireEvent.click(await screen.findByTestId('meeting-ask'))
    const items = await screen.findAllByTestId('meeting-ask-item')
    expect(items.map((i) => i.textContent)).toEqual([
      'Catch me up',
      'Draft a reply',
      'List actions',
    ])
    expect(screen.getByTestId('meeting-ask')).toHaveTextContent('Ask astra…')
    fireEvent.click(items[0]!)
    await waitFor(() =>
      expect(askInChat).toHaveBeenCalledWith('astra', 'Catch me up on the meeting'),
    )
    expect(tab()).not.toHaveTextContent('Catch me up on the meeting')
  })

  it('ends the meeting through meetings.stop', async () => {
    wrap()
    fireEvent.click(await screen.findByTestId('meeting-end'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('meetings.stop', { id: ID }))
  })
})

describe('MeetingTab after the call', () => {
  it('leads with Summary: the gist, For you, Actions, Decided', async () => {
    rec = recording({ stage: 'done', endedAt: startedAt + 42 * MIN })
    notes = {
      attendees: [],
      attendeesSource: null,
      summary: ['Release status and an admin view.', 'MFA by month end.'],
      decisions: [],
      questions: [],
      transcript: [],
    }
    wrap()
    const recap = await screen.findByTestId('meeting-recap')
    expect(recap).toHaveTextContent('Release status and an admin view. MFA by month end.')
    const tabs = within(screen.getByTestId('meeting-tabs')).getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Summary', 'Transcript', 'Moments'])
    const labels = [...recap.querySelectorAll('.eva-meeting-tab-label')].map((l) => l.textContent)
    expect(labels).toEqual(['For you', 'Actions', 'Decided', 'Shared screen'])
    expect(screen.getByTestId('meeting-for-you')).toHaveTextContent(
      'Isaac to take the dashboardTodd asked at 35:00, no reply yet',
    )
    expect(recap).toHaveTextContent('Ship the release Thursday if QA is clean')
    expect(within(recap).getAllByTestId('meeting-shot')).toHaveLength(2)
    expect(screen.getByTestId('meeting-tab-when')).toHaveTextContent(/ · 42 min$/)
    expect(screen.queryByTestId('meeting-end')).toBeNull()
    expect(screen.getByTestId('meeting-ask')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('meeting-tab-moments'))
    expect(screen.getAllByTestId('meeting-moment')[1]).toHaveTextContent(
      'Asks you · Todd · no reply yet',
    )
  })

  it('switches to Summary when the call ends', async () => {
    wrap()
    fireEvent.click(await screen.findByTestId('meeting-tab-transcript'))
    push({ kind: 'recording', recording: recording({ stage: 'summarizing', endedAt: Date.now() }) })
    expect(await screen.findByTestId('meeting-recap')).toHaveTextContent('Writing notes')
    expect(screen.getByTestId('meeting-tab-summary')).toHaveAttribute('aria-selected', 'true')
  })
})
