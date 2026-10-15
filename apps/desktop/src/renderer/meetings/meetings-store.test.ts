import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))

import { meetingTitle } from '../eva/names-store'
import { reloadPages } from '../reload/reload'
import {
  loadMeeting,
  loadMeetings,
  meetingsStore,
  mountMeetings,
  resetMeetingsForTests,
} from './meetings-store'

const listValue = (title = 'Daily standup') => ({
  now: 1,
  meetings: [
    { stem: 'standup', title, start: null, skipped: false, skippedReason: null, pending: 0, hasNotes: false },
  ],
  digest: { recentCount: 0, waiting: [], out: [], decisions: [] },
})

beforeEach(() => {
  invoke.mockReset()
  resetMeetingsForTests()
})

describe('meetingsStore', () => {
  it('collapses concurrent loads into one follow-up', async () => {
    let release!: () => void
    invoke.mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ ok: true, value: listValue() }))),
    )
    invoke.mockResolvedValue({ ok: true, value: listValue() })
    const a = loadMeetings()
    void loadMeetings()
    void loadMeetings()
    release()
    await a
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(meetingsStore.getState().list).toHaveLength(1)
    expect(meetingsStore.getState().loading).toBe(false)
  })

  it('publishes titles by stem after each list load', async () => {
    invoke.mockResolvedValue({ ok: true, value: listValue('Standup!') })
    await loadMeetings()
    expect(meetingTitle('standup')).toBe('Standup!')
  })

  it('flags an error when the list fails', async () => {
    invoke.mockResolvedValue({ ok: false, error: { code: 'internal', message: 'x' } })
    await loadMeetings()
    expect(meetingsStore.getState()).toMatchObject({ error: true, loading: false, list: null })
  })

  it('caches details per stem and refreshes them on reload', async () => {
    const detail = (n: number) => ({ ok: true, value: { meeting: null, notes: 'none', protocol: null, n } })
    invoke.mockImplementation(async (ch: string) =>
      ch === 'meetings.list' ? { ok: true, value: listValue() } : detail(invoke.mock.calls.length),
    )
    const off = mountMeetings()
    await loadMeeting('standup')
    const first = meetingsStore.getState().details.standup
    expect(first).toBeDefined()
    await reloadPages()
    expect(meetingsStore.getState().details.standup).not.toBe(first)
    off()
    invoke.mockClear()
    await reloadPages()
    expect(invoke).not.toHaveBeenCalled()
  })
})
