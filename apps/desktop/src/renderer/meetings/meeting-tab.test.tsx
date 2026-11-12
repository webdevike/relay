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
let lines: unknown[] = LINES
let notes: unknown = null
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
      return { ok: true, value: { recording: rec, lines, astra: null, notes } }
    if (ch === 'meetings.stop') return { ok: true, value: { stopped: true } }
    return { ok: true, value: {} }
  })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('MeetingTab on the call', () => {
  it('leads with Now: the speaker, what they said, what came before, the latest moments', async () => {
    wrap()
    const speaker = await screen.findByTestId('meeting-speaker')
    await waitFor(() => expect(speaker).toHaveTextContent('Chris'))
    expect(speaker).toHaveTextContent('Looks like three accounts failed on the same step.')
    expect(speaker).toHaveTextContent('Before that, Todd: Isaac, can you take the dashboard?')
    const tabs = within(screen.getByTestId('meeting-tabs')).getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Now', 'Transcript', 'Moments'])
    expect(screen.getByTestId('meeting-tab-now')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('meeting-tab-when')).toHaveTextContent('56 min')
    expect(tab()).toHaveTextContent('Teams·Live·56 min')
    expect(screen.getByTestId('meeting-end')).toHaveTextContent('End meeting')
    // Newest first, three of them; the open question to Isaac carries how long ago it was.
    const moments = screen.getAllByTestId('meeting-moment')
    expect(moments.map((m) => m.dataset.kind)).toEqual(['you', 'decision', 'action'])
    expect(moments[0]).toHaveTextContent('Isaac, can you take the dashboard?')
    expect(moments[0]).toHaveTextContent('Todd · 21 min ago, no reply yet')
    expect(moments[0]).toHaveAttribute('data-open', 'true')
    expect(moments[1]).toHaveTextContent('Decision · Todd')
    expect(moments[2]).toHaveTextContent('Action · Priya')
  })

  it('lists every moment newest first', async () => {
    wrap()
    fireEvent.click(await screen.findByTestId('meeting-tab-moments'))
    const kinds = screen.getAllByTestId('meeting-moment').map((m) => m.dataset.kind)
    expect(kinds).toEqual(['you', 'decision', 'action'])
  })

  it('says "Nothing yet." when the call has no moments', async () => {
    lines = LINES.slice(2, 3)
    wrap()
    fireEvent.click(await screen.findByTestId('meeting-tab-moments'))
    expect(view()).toHaveTextContent('Nothing yet.')
  })

  it('jumps from a moment to its transcript row and lights it up for a while', async () => {
    wrap()
    const todd = (await screen.findAllByTestId('meeting-moment'))[0]!
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
    expect(labels).toEqual(['For you', 'Actions', 'Decided'])
    expect(screen.getByTestId('meeting-for-you')).toHaveTextContent(
      'Isaac, can you take the dashboard?Todd asked at 35m, no reply yet',
    )
    expect(screen.getByTestId('meeting-tab-when')).toHaveTextContent(/ · 42 min$/)
    expect(screen.queryByTestId('meeting-end')).toBeNull()
    expect(screen.getByTestId('meeting-ask')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('meeting-tab-moments'))
    expect(screen.getAllByTestId('meeting-moment')[0]).toHaveTextContent('Todd · no reply yet')
  })

  it('switches to Summary when the call ends', async () => {
    wrap()
    fireEvent.click(await screen.findByTestId('meeting-tab-transcript'))
    push({ kind: 'recording', recording: recording({ stage: 'summarizing', endedAt: Date.now() }) })
    expect(await screen.findByTestId('meeting-recap')).toHaveTextContent('Writing notes')
    expect(screen.getByTestId('meeting-tab-summary')).toHaveAttribute('aria-selected', 'true')
  })
})
