import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ID = '6f1c2b8e-0d1a-4c55-9a51-3b2f0c7d9e10'
const listeners = vi.hoisted(() => new Map<string, (p: unknown) => void>())
const invoke = vi.hoisted(() => vi.fn())
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: (ch: string, cb: (p: unknown) => void) => {
    listeners.set(ch, cb)
    return () => listeners.delete(ch)
  },
}))
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }))
vi.mock('../navigation/navigate', () => ({ openPlace: vi.fn(), setNavigator: () => {} }))
vi.mock('../chat/markdown/Markdown', () => ({
  Markdown: ({ text }: { text: string }) => <p>{text}</p>,
}))

import { createTabs, placeOf } from '@evaos/shell-core'
import { resetReloadForTests } from '../reload/reload'
import { tabsStore } from '../tabs/tabs-store'
import { MeetingPage } from './MeetingPage'
import { MeetingsList } from './MeetingsList'
import { resetMeetingsForTests } from './meetings-store'

const recording = (over = {}) => ({
  id: ID,
  app: 'Microsoft Teams',
  title: 'Weekly Engineering Sync',
  startedAt: Date.now() - 65_000,
  endedAt: null,
  device: "Isaac's Mac mini",
  stage: 'recording',
  health: 'ok',
  healthDetail: 'Hearing Microsoft Teams and your mic',
  error: null,
  shadow: true,
  stem: null,
  seconds: 65,
  ...over,
})
const line = (id: string, track: 'app' | 'mic', startMs: number, text: string, over = {}) => ({
  id,
  track,
  speaker: track === 'mic' ? 'Isaac' : 'Todd',
  startMs,
  endMs: startMs + 2000,
  text,
  final: true,
  ...over,
})

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

beforeEach(() => {
  invoke.mockReset()
  listeners.clear()
  resetReloadForTests()
  resetMeetingsForTests()
  tabsStore.setState(
    {
      tabs: createTabs(
        [{ id: 0, here: placeOf('meetings'), back: [], forward: [], pinned: false }],
        0,
      ),
      loaded: true,
    },
    true,
  )
  invoke.mockImplementation(async (ch: string) => {
    if (ch === 'meetings.list')
      return {
        ok: true,
        value: {
          now: Date.now(),
          meetings: [],
          recordings: [recording()],
          digest: { recentCount: 0, waiting: [], out: [], decisions: [] },
        },
      }
    if (ch === 'meetings.open')
      return {
        ok: true,
        value: {
          recording: recording(),
          lines: [
            line('app-0', 'app', 0, 'Release is Tuesday.'),
            line('mic-1', 'mic', 3000, 'Release is Tuesday.', { echo: true }),
          ],
          astra: null,
          notes: null,
        },
      }
    if (ch === 'meetings.ask')
      return {
        ok: true,
        value: {
          turns: [{ id: 'q', role: 'user', text: 'When is the release?', streaming: false }],
          working: true,
          waiting: null,
          error: null,
        },
      }
    return { ok: true, value: {} }
  })
})

describe('Relay recordings', () => {
  it('lists a call in progress under Live with its elapsed time', async () => {
    wrap(<MeetingsList query="" />)
    const row = await screen.findByTestId(`recording-row-${ID}`)
    expect(screen.getByTestId('meetings-live-label')).toHaveTextContent('Live')
    expect(row).toHaveTextContent('Weekly Engineering Sync')
    expect(row).toHaveTextContent(/1:0\d/)
    expect(row.querySelector('[aria-label="Recording"]')).not.toBeNull()
  })

  it('shows the live transcript, applies pushed lines, hides echo and asks Astra', async () => {
    wrap(<MeetingPage place={placeOf('meetings', { meeting: ID })} />)
    await screen.findByTestId('recording-transcript')
    expect(screen.getByTestId('recording-stage')).toHaveTextContent(
      'Hearing Microsoft Teams and your mic',
    )
    expect(screen.getByTestId('recording-shadow')).toBeInTheDocument()
    expect(screen.getAllByTestId('recording-line')).toHaveLength(1)
    act(() =>
      listeners.get('meetings.changed')?.({
        kind: 'live',
        id: ID,
        upsert: [line('mic-9', 'mic', 9000, 'I can take it', { final: false })],
      }),
    )
    const lines = screen.getAllByTestId('recording-line')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toHaveAttribute('data-draft', 'true')
    expect(lines[1]).toHaveTextContent('IsaacI can take it')

    fireEvent.change(screen.getByTestId('recording-question'), {
      target: { value: 'When is the release?' },
    })
    fireEvent.keyDown(screen.getByTestId('recording-question'), { key: 'Enter' })
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('meetings.ask', {
        id: ID,
        question: 'When is the release?',
      }),
    )
    expect(await screen.findByText('Astra is thinking')).toBeInTheDocument()
    act(() =>
      listeners.get('meetings.changed')?.({
        kind: 'astra',
        id: ID,
        astra: {
          turns: [
            { id: 'q', role: 'user', text: 'When is the release?', streaming: false },
            { id: 'a', role: 'assistant', text: 'Tuesday, per Todd.', streaming: false },
          ],
          working: false,
          waiting: null,
          error: null,
        },
      }),
    )
    expect(screen.getByText('Tuesday, per Todd.')).toBeInTheDocument()

    act(() =>
      listeners.get('meetings.changed')?.({
        kind: 'recording',
        recording: recording({ stage: 'summarizing', endedAt: Date.now() }),
      }),
    )
    expect(screen.getByTestId('recording-stage')).toHaveTextContent('Writing notes')
    expect(screen.queryByTestId('recording-stop')).toBeNull()
  })
})
