import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const data = vi.hoisted(() => ({
  list: null as unknown,
  details: {} as Record<string, unknown>,
  open: null as unknown,
}))
const invoke = vi.fn(async (ch: string, input: { stem?: string }) => {
  if (ch === 'meetings.list') return { ok: true, value: data.list }
  if (ch === 'meetings.get') return { ok: true, value: data.details[input.stem!] }
  if (ch === 'meetings.openNotes') return data.open ?? { ok: true, value: { opened: true } }
  return { ok: true, value: {} }
})
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...(a as [string, never])),
  on: () => () => {},
}))
const show = vi.fn()
vi.mock('@mantine/notifications', () => ({
  notifications: { show: (...a: unknown[]) => show(...a) },
}))
const openPlace = vi.fn()
vi.mock('../navigation/navigate', () => ({
  openPlace: (...a: unknown[]) => openPlace(...a),
  setNavigator: () => {},
}))

import { createTabs, placeOf } from '@evaos/shell-core'
import { resetReloadForTests } from '../reload/reload'
import { tabsStore } from '../tabs/tabs-store'
import { MeetingsHome } from './MeetingsHome'
import { MeetingPage } from './MeetingPage'
import { MeetingsList } from './MeetingsList'
import { resetMeetingsForTests } from './meetings-store'

const at = (days: number, h: number, m: number): string =>
  new Date(2026, 9, 15 - days, h, m).toISOString()
const NOW = new Date(2026, 9, 15, 12, 0, 0).getTime()

const prop = (id: string, status = 'proposed', over = {}) => ({
  id,
  kind: 'todo',
  text: `Text ${id}`,
  workspace: null,
  item: null,
  p: null,
  source: 'Isaac',
  status,
  ...over,
})
const sum = (stem: string, title: string, start: string | null, over = {}) => ({
  stem,
  title,
  start,
  skipped: false,
  skippedReason: null,
  pending: 0,
  hasNotes: false,
  ...over,
})

const LIST = {
  now: NOW,
  meetings: [
    sum('test-call', 'Test call', at(0, 16, 0), { skipped: true, skippedReason: 'test' }),
    sum('standup', 'Daily standup', at(0, 9, 30), { pending: 2, hasNotes: true }),
    sum('planning', 'Sprint planning', at(1, 14, 0), { pending: 1 }),
    sum('retro', 'Retro', at(10, 15, 0)),
    sum('undated', 'Undated sync', null),
  ],
  digest: {
    recentCount: 2,
    waiting: [
      { stem: 'standup', title: 'Daily standup', proposal: prop('standup#1') },
      { stem: 'standup', title: 'Daily standup', proposal: prop('standup#2') },
      {
        stem: 'planning',
        title: 'Sprint planning',
        proposal: prop('planning#2', 'proposed', { source: null }),
      },
    ],
    out: [{ text: 'Sam is out', date: '2026-10-18', stem: 'standup', title: 'Daily standup' }],
    decisions: Array.from({ length: 7 }, (_, i) => ({
      text: `Decision ${i}`,
      stem: 'standup',
      title: 'Daily standup',
    })),
  },
}

const PROTOCOL = {
  attendees: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
  attendeesSource: null,
  summary: ['First paragraph.', 'Second paragraph.'],
  decisions: ['Ship it'],
  questions: ['Who owns triage?'],
  transcript: [
    { time: '00:01', speaker: 'Isaac', text: 'Morning all' },
    { time: '00:05', speaker: 'Sam', text: 'Beta is ready' },
    { time: '00:09', speaker: null, text: 'wrapped line' },
  ],
}
const DETAIL = {
  meeting: {
    ...sum('standup', 'Daily standup', at(0, 9, 30), { pending: 2, hasNotes: true }),
    proposals: [
      prop('standup#1'),
      prop('standup#2'),
      prop('standup#3', 'accepted'),
      prop('standup#4', 'dismissed'),
    ],
    memorized: [],
  },
  notes: 'ok',
  protocol: PROTOCOL,
}

function seedTab(page: string, extra = {}): void {
  tabsStore.setState(
    {
      tabs: createTabs(
        [{ id: 0, here: placeOf(page as never, extra), back: [], forward: [], pinned: false }],
        0,
      ),
      loaded: true,
    },
    true,
  )
}
const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

beforeEach(() => {
  invoke.mockClear()
  show.mockClear()
  openPlace.mockClear()
  resetReloadForTests()
  resetMeetingsForTests()
  data.list = LIST
  data.details = { standup: DETAIL }
  data.open = null
  seedTab('meetings')
})

describe('MeetingsList', () => {
  it('groups by day, folds test calls and marks waiting rows', async () => {
    wrap(<MeetingsList query="" />)
    await screen.findByTestId('meetings-list')
    const days = screen.getAllByTestId('meetings-day-label').map((n) => n.textContent)
    expect(days).toEqual(['Today', 'Yesterday', 'Oct 5', 'Undated'])
    expect(screen.getByTestId('meetings-list')).toHaveAttribute('data-density', 'compact')
    const row = screen.getByTestId('meeting-row-standup')
    expect(row).toHaveTextContent('Daily standup')
    expect(row).toHaveTextContent(/\d{1,2}:\d{2}\s?[AP]M/)
    expect(screen.getByTestId('meeting-waiting-standup')).toHaveAttribute(
      'aria-label',
      'Waiting on you, 2 proposals',
    )
    expect(screen.getByTestId('meeting-waiting-planning')).toHaveAttribute(
      'aria-label',
      'Waiting on you, 1 proposal',
    )
    const tests = screen.getByTestId('meetings-tests-head')
    expect(screen.getByTestId('meetings-tests-label')).toHaveTextContent('Test calls')
    expect(screen.getByTestId('meetings-tests-count')).toHaveTextContent('1')
    expect(tests).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('meeting-row-test-call')).toBeNull()
    fireEvent.click(tests)
    expect(tests).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('meeting-row-test-call')).toHaveAttribute('data-dim', 'true')
  })

  it('opens a meeting, in a new tab with the meta key', async () => {
    wrap(<MeetingsList query="" />)
    const row = await screen.findByTestId('meeting-row-standup')
    fireEvent.click(row)
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('meetings', { meeting: 'standup' }), {
      newTab: false,
    })
    fireEvent.click(row, { metaKey: true, shiftKey: true })
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('meetings', { meeting: 'standup' }), {
      newTab: true,
    })
  })

  it('marks the active meeting row', async () => {
    seedTab('meetings', { meeting: 'planning' })
    wrap(<MeetingsList query="" />)
    await screen.findByTestId('meetings-list')
    expect(screen.getByTestId('meeting-row-planning')).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId('meeting-row-standup')).not.toHaveAttribute('data-active')
  })

  it('filters by title and handles empty states', async () => {
    const { rerender } = wrap(<MeetingsList query="plan" />)
    await screen.findByTestId('meetings-list')
    expect(screen.getByTestId('meeting-row-planning')).toBeInTheDocument()
    expect(screen.queryByTestId('meeting-row-standup')).toBeNull()
    rerender(
      <MantineProvider>
        <MeetingsList query="test" />
      </MantineProvider>,
    )
    expect(screen.getByTestId('meetings-tests-head')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('meeting-row-test-call')).toBeInTheDocument()
    rerender(
      <MantineProvider>
        <MeetingsList query="zzz" />
      </MantineProvider>,
    )
    expect(screen.getByTestId('sidebar-sub-empty')).toHaveTextContent('No meetings match.')
  })

  it('shows loading then the no-records state', async () => {
    data.list = { ...LIST, meetings: [] }
    wrap(<MeetingsList query="" />)
    expect(screen.getByTestId('sidebar-sub-empty')).toHaveTextContent('Loading meetings')
    await waitFor(() =>
      expect(screen.getByTestId('sidebar-sub-empty')).toHaveTextContent('No meetings yet.'),
    )
  })
})

describe('MeetingsHome', () => {
  it('shows the summary and sections', async () => {
    wrap(<MeetingsHome place={placeOf('meetings')} />)
    expect(await screen.findByTestId('meetings-summary')).toHaveTextContent(
      '2 meetings this week, 3 waiting on you',
    )
    const waiting = within(screen.getByTestId('meetings-waiting'))
    expect(waiting.getAllByTestId(/^proposal-/)).toHaveLength(3)
    expect(waiting.getAllByText('Daily standup')).toHaveLength(2)
    expect(waiting.getAllByText('From Isaac')).toHaveLength(2)
    expect(within(screen.getByTestId('meetings-out')).getByText('Sam is out')).toBeInTheDocument()
    expect(within(screen.getByTestId('meetings-out')).getByText('Sun, Oct 18')).toBeInTheDocument()
  })

  it('uses the singular and the empty state', async () => {
    data.list = {
      ...LIST,
      digest: { ...LIST.digest, recentCount: 1, waiting: [], out: [], decisions: [] },
    }
    wrap(<MeetingsHome place={placeOf('meetings')} />)
    expect(await screen.findByTestId('meetings-summary')).toHaveTextContent(
      '1 meeting this week, 0 waiting on you',
    )
    expect(screen.getByText('Nothing waiting on you.')).toBeInTheDocument()
    expect(screen.queryByTestId('meetings-out')).toBeNull()
  })

  it('limits decisions to five with a toggle', async () => {
    wrap(<MeetingsHome place={placeOf('meetings')} />)
    const box = await screen.findByTestId('meetings-decisions')
    expect(within(box).getAllByText(/^Decision/)).toHaveLength(5)
    fireEvent.click(screen.getByTestId('meetings-decisions-toggle'))
    expect(within(box).getAllByText(/^Decision/)).toHaveLength(7)
    expect(screen.getByTestId('meetings-decisions-toggle')).toHaveTextContent('Show fewer')
  })
})

describe('MeetingPage', () => {
  const page = () => wrap(<MeetingPage place={placeOf('meetings', { meeting: 'standup' })} />)

  it('shows loading, then title, chips and overview sections', async () => {
    page()
    expect(screen.getByText('Loading notes')).toBeInTheDocument()
    expect(await screen.findByTestId('meeting-title')).toHaveTextContent('Daily standup')
    expect(screen.getByTestId('meeting-when').textContent).toMatch(/\d{1,2}:\d{2}/)
    const chips = within(screen.getByTestId('meeting-attendees'))
    expect(chips.getByText('F')).toBeInTheDocument()
    expect(chips.queryByText('G')).toBeNull()
    expect(chips.getByText('+2')).toBeInTheDocument()
    expect(screen.getByTestId('meeting-open-notes')).toHaveTextContent('Open Notes')
    for (const h of [
      'Summary',
      'Decisions',
      'Open questions',
      'Attendees',
      'For you',
      'Remembered',
    ]) {
      expect(screen.getByRole('heading', { name: h })).toBeInTheDocument()
    }
    expect(
      within(screen.getByTestId('meeting-for-you')).getAllByTestId(/^proposal-standup/),
    ).toHaveLength(2)
    const rem = within(screen.getByTestId('meeting-remembered'))
    expect(rem.getByTestId('proposal-status-standup#3')).toHaveTextContent('Accepted')
    expect(rem.getByTestId('proposal-status-standup#4')).toHaveTextContent('Dismissed')
  })

  it('filters the transcript', async () => {
    page()
    fireEvent.click(await screen.findByTestId('meeting-tab-transcript'))
    expect(screen.getAllByTestId('meeting-line')).toHaveLength(3)
    const input = screen.getByLabelText('Filter transcript')
    fireEvent.change(input, { target: { value: 'beta' } })
    expect(screen.getAllByTestId('meeting-line')).toHaveLength(1)
    fireEvent.change(input, { target: { value: 'qqq' } })
    expect(screen.getByText('No lines match.')).toBeInTheDocument()
  })

  it('toasts when Open Notes fails', async () => {
    data.open = {
      ok: false,
      error: { code: 'open-failed', message: 'Could not open /x/standup.md' },
    }
    page()
    fireEvent.click(await screen.findByTestId('meeting-open-notes'))
    await waitFor(() => expect(show).toHaveBeenCalled())
    expect(show.mock.calls[0]![0].message).toBe(
      'Could not open /x/standup.md. Check that the file exists, then try again.',
    )
  })

  it('handles empty notes, missing notes and test calls', async () => {
    data.details = {
      standup: { ...DETAIL, notes: 'none', protocol: null },
    }
    const { unmount } = page()
    await screen.findByTestId('meeting-title')
    expect(screen.getByText('The notes have no summary.')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('meeting-tab-transcript'))
    expect(screen.getByText('The notes have no transcript.')).toBeInTheDocument()
    unmount()

    resetMeetingsForTests()
    data.details = { standup: { ...DETAIL, notes: 'missing', protocol: null } }
    const second = page()
    await screen.findByText('Notes file not found')
    second.unmount()

    resetMeetingsForTests()
    data.details = {
      standup: {
        ...DETAIL,
        meeting: { ...DETAIL.meeting, skipped: true },
        notes: 'none',
        protocol: null,
      },
    }
    page()
    expect(await screen.findByText('Eva skipped this as a test call.')).toBeInTheDocument()
    expect(act).toBeDefined()
  })
})

describe('proposal actions', () => {
  function respond(map: Record<string, unknown>): void {
    invoke.mockImplementation((async (ch: string, input: { stem?: string }) => {
      if (ch in map) return map[ch]
      if (ch === 'meetings.list') return { ok: true, value: data.list }
      if (ch === 'meetings.get') return { ok: true, value: data.details[input.stem!] }
      return { ok: true, value: {} }
    }) as never)
  }
  const detailWith = (statuses: Record<string, string>) => ({
    ...DETAIL,
    meeting: {
      ...DETAIL.meeting,
      proposals: DETAIL.meeting.proposals.map((p) => ({
        ...p,
        status: statuses[p.id] ?? p.status,
      })),
    },
  })

  it('shows both actions and disables them while pending', async () => {
    let release!: (v: unknown) => void
    respond({ 'meetings.accept': new Promise((r) => (release = r)) })
    invoke.mockImplementationOnce(async () => ({ ok: true, value: {} }))
    seedTab('meetings', { meeting: 'standup' })
    wrap(<MeetingPage place={placeOf('meetings', { meeting: 'standup' })} />)
    const accept = await screen.findByTestId('meeting-accept-standup#1')
    expect(accept).toHaveTextContent('Accept todo')
    expect(screen.getByTestId('meeting-dismiss-standup#1')).toHaveTextContent('Dismiss proposal')
    fireEvent.click(accept)
    await waitFor(() => expect(screen.getByTestId('meeting-dismiss-standup#1')).toBeDisabled())
    expect(screen.getByTestId('meeting-accept-standup#2')).not.toBeDisabled()
    release({ ok: true, value: { todoId: 'T16', tag: 'eva' } })
  })

  it('accept toasts, reloads and moves the row to Remembered', async () => {
    respond({ 'meetings.accept': { ok: true, value: { todoId: 'T16', tag: 'eva' } } })
    seedTab('meetings', { meeting: 'standup' })
    wrap(<MeetingPage place={placeOf('meetings', { meeting: 'standup' })} />)
    const btn = await screen.findByTestId('meeting-accept-standup#1')
    data.details = { standup: detailWith({ 'standup#1': 'accepted' }) }
    fireEvent.click(btn)
    await waitFor(() =>
      expect(show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Added T16 to Eva.' })),
    )
    await waitFor(() =>
      expect(
        within(screen.getByTestId('meeting-remembered')).getByTestId('proposal-status-standup#1'),
      ).toHaveTextContent('Accepted'),
    )
  })

  it('dismiss toasts without a confirmation and shows Dismissed', async () => {
    respond({ 'meetings.dismiss': { ok: true, value: { status: 'dismissed' } } })
    seedTab('meetings', { meeting: 'standup' })
    wrap(<MeetingPage place={placeOf('meetings', { meeting: 'standup' })} />)
    const btn = await screen.findByTestId('meeting-dismiss-standup#2')
    data.details = { standup: detailWith({ 'standup#2': 'dismissed' }) }
    fireEvent.click(btn)
    await waitFor(() =>
      expect(show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Dismissed.' })),
    )
    await waitFor(() =>
      expect(screen.getByTestId('proposal-status-standup#2')).toHaveTextContent('Dismissed'),
    )
  })

  it('shows the changed-on-disk alert with Reload, and the partial-accept message', async () => {
    respond({ 'meetings.accept': { ok: false, error: { code: 'not-proposed', message: 'x' } } })
    seedTab('meetings', { meeting: 'standup' })
    wrap(<MeetingPage place={placeOf('meetings', { meeting: 'standup' })} />)
    fireEvent.click(await screen.findByTestId('meeting-accept-standup#1'))
    const alert = await screen.findByTestId('meeting-refusal-standup#1')
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert).toHaveTextContent(
      'work/meetings/standup.json changed on disk. Reload the meeting and try again.',
    )
    const before = invoke.mock.calls.filter((c) => c[0] === 'meetings.get').length
    fireEvent.click(screen.getByTestId('meeting-reload-standup#1'))
    await waitFor(() =>
      expect(invoke.mock.calls.filter((c) => c[0] === 'meetings.get').length).toBeGreaterThan(
        before,
      ),
    )
    expect(screen.queryByTestId('meeting-refusal-standup#1')).toBeNull()

    respond({
      'meetings.accept': {
        ok: false,
        error: {
          code: 'partial-accept',
          message: 'Added T16 but could not mark the proposal accepted. Reload the meeting.',
        },
      },
    })
    fireEvent.click(screen.getByTestId('meeting-accept-standup#2'))
    expect(await screen.findByTestId('meeting-refusal-standup#2')).toHaveTextContent(
      'Added T16 but could not',
    )
  })

  it('Home waiting rows carry the actions and drop after success', async () => {
    respond({ 'meetings.dismiss': { ok: true, value: { status: 'dismissed' } } })
    wrap(<MeetingsHome place={placeOf('meetings')} />)
    const btn = await screen.findByTestId('meeting-dismiss-planning#2')
    expect(screen.getByTestId('meeting-accept-planning#2')).toBeInTheDocument()
    data.list = {
      ...LIST,
      digest: {
        ...LIST.digest,
        waiting: LIST.digest.waiting.filter((w) => w.proposal.id !== 'planning#2'),
      },
    }
    fireEvent.click(btn)
    await waitFor(() => expect(screen.queryByTestId('proposal-planning#2')).toBeNull())
  })
})
