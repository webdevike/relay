import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { makeMessage } from '@evaos/chat-core/message'
import type { TrialCardView, TrialSwitchView, TrialsView } from '@evaos/contract'

const invoke = vi.hoisted(() => vi.fn())
const listeners = vi.hoisted(() => new Map<string, (payload: unknown) => void>())
const toasts = vi.hoisted(() => vi.fn())
vi.mock('../../ipc', () => ({
  invoke,
  on: (channel: string, fn: (payload: unknown) => void) => {
    listeners.set(channel, fn)
    return () => listeners.delete(channel)
  },
}))
vi.mock('@mantine/notifications', () => ({ notifications: { show: toasts } }))

import type { LogItem } from '../ChatLog'
import { TrialCard } from './TrialCard'
import { TrialSwitchRow } from './TrialSwitchRow'
import {
  PICK_FAILED,
  placeTrialRows,
  startTrials,
  trialsStore,
  useThreadTrialRows,
  type TrialRow,
} from './trials-store'

const THREAD = 'assistant:nova'
const card = (arms: TrialCardView['arms'], extra: Partial<TrialCardView> = {}): TrialCardView => ({
  id: 't1',
  agent: 'diagram',
  label: 'Diagram',
  thread: THREAD,
  at: 1000,
  request: 'A flow chart of the deploy',
  arms,
  ...extra,
})
const change = (undone: boolean): TrialSwitchView => ({
  id: 's1',
  agent: 'diagram',
  label: 'Diagram',
  thread: THREAD,
  at: 5000,
  text: 'Diagram: switched to Sonnet 5.5, won 8 of your last 10 picks',
  from: 'opus',
  to: 'sonnet',
  fromLabel: 'Opus 5.5',
  toLabel: 'Sonnet 5.5',
  kept: false,
  undone,
})
const wrap = (ui: React.ReactElement) => render(<MantineProvider>{ui}</MantineProvider>)
const host = (v: TrialsView) => act(() => listeners.get('trials.changed')!(v))

beforeEach(() => {
  invoke.mockReset()
  toasts.mockReset()
  trialsStore.setState({ up: true, trials: [], switches: [] })
})

describe('a trial card', () => {
  it('runs per pane with no model names, then lets Isaac pick once two are done', async () => {
    const running = card([
      { letter: 'A', status: 'running', model: 'leak', modelLabel: 'Leaked 1' },
      { letter: 'B', status: 'done', preview: '**Boxes** and arrows' },
      { letter: 'C', status: 'failed', error: 'rate limited' },
    ])
    const { rerender } = wrap(<TrialCard trial={running} />)
    expect(screen.getByText('Diagram · which is better?')).toBeInTheDocument()
    expect(screen.getByTestId('trial-pane-A')).toHaveAttribute('data-status', 'running')
    expect(screen.getByTestId('trial-pane-B')).toHaveTextContent('Boxes and arrows')
    expect(screen.getByTestId('trial-pane-C')).toHaveTextContent("Didn't finish")
    // Before the pick no model shows, even one the host should not have sent.
    expect(screen.getByTestId('trial-t1')).not.toHaveTextContent('Leaked')
    // One finished result is nothing to compare.
    for (const p of ['A', 'B', 'C', 'unsure'])
      expect(screen.getByTestId(`trial-pick-${p}`)).toBeDisabled()

    const two = card([
      { letter: 'A', status: 'done', preview: 'Plain list' },
      running.arms[1]!,
      running.arms[2]!,
    ])
    rerender(
      <MantineProvider>
        <TrialCard trial={two} />
      </MantineProvider>,
    )
    expect(screen.getByTestId('trial-pick-A')).toBeEnabled()
    expect(screen.getByTestId('trial-pick-B')).toBeEnabled()
    expect(screen.getByTestId('trial-pick-unsure')).toBeEnabled()
    expect(screen.getByTestId('trial-pick-C')).toBeDisabled()

    invoke.mockResolvedValueOnce({ ok: true, value: { ok: false, error: 'Already picked' } })
    fireEvent.click(screen.getByTestId('trial-pick-B'))
    expect(invoke).toHaveBeenCalledWith('trials.pick', { trial: 't1', pick: 'B' })
    await waitFor(() =>
      expect(toasts).toHaveBeenCalledWith(
        expect.objectContaining({ color: 'red', message: `${PICK_FAILED} Already picked` }),
      ),
    )
    // Refused: the buttons come back.
    await waitFor(() => expect(screen.getByTestId('trial-pick-B')).toBeEnabled())
  })

  it('names the models under the letters after the pick, marks the pick and drops the buttons', () => {
    wrap(
      <TrialCard
        trial={card(
          [
            { letter: 'A', status: 'done', preview: 'a', modelLabel: 'GPT-6.1 Sol' },
            { letter: 'B', status: 'done', preview: 'b', model: 'claude-sonnet-5-5' },
          ],
          { pick: 'B', pickedAt: 2000 },
        )}
      />,
    )
    expect(screen.getByText('Diagram · you picked B')).toBeInTheDocument()
    expect(screen.getByTestId('trial-model-A')).toHaveTextContent('GPT-6.1 Sol')
    expect(screen.getByTestId('trial-model-B')).toHaveTextContent('claude-sonnet-5-5')
    expect(screen.getByTestId('trial-pane-B')).toHaveAttribute('data-picked', 'true')
    expect(screen.getByTestId('trial-pane-A')).not.toHaveAttribute('data-picked')
    expect(screen.queryByTestId('trial-pick-A')).toBeNull()
    expect(screen.queryByTestId('trial-pick-unsure')).toBeNull()
  })
})

describe('a switch message', () => {
  it('sends Undo, and once undone says so instead of the button', async () => {
    invoke.mockResolvedValueOnce({ ok: true, value: { ok: true } })
    const { rerender } = wrap(<TrialSwitchRow change={change(false)} />)
    expect(screen.getByTestId('trial-switch-s1')).toHaveTextContent(
      'Diagram: switched to Sonnet 5.5',
    )
    fireEvent.click(screen.getByTestId('trial-undo'))
    expect(invoke).toHaveBeenCalledWith('trials.undo', { switch: 's1' })
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    rerender(
      <MantineProvider>
        <TrialSwitchRow change={change(true)} />
      </MantineProvider>,
    )
    expect(screen.getByTestId('trial-undone')).toHaveTextContent(
      'Undone: back on Opus 5.5, trial on again',
    )
    expect(screen.queryByTestId('trial-undo')).toBeNull()
    expect(toasts).not.toHaveBeenCalled()
  })
})

describe('trial rows in a chat', () => {
  it("follow the host's pushes, keep this chat's own, and keep unchanged ones as they were", () => {
    invoke.mockResolvedValue({ ok: false })
    const stop = startTrials()
    expect(invoke).toHaveBeenCalledWith('trials.get', {})
    const a = card([
      { letter: 'A', status: 'running' },
      { letter: 'B', status: 'running' },
    ])
    const other = { ...a, id: 't2', thread: 'assistant:astra' }
    host({ up: true, trials: [a, other], switches: [change(false)] })
    const { result } = renderHook(() => useThreadTrialRows(THREAD))
    const first = result.current
    expect(first.map((r) => [r.kind, r.item.id])).toEqual([
      ['trial', 't1'],
      ['trialSwitch', 's1'],
    ])
    // Another chat's card changed: this chat's rows stay the same array.
    host({
      up: true,
      trials: [
        { ...a },
        { ...other, arms: [{ letter: 'A', status: 'done', preview: 'x' }, other.arms[1]!] },
      ],
      switches: [change(false)],
    })
    expect(result.current).toBe(first)
    host({ up: true, trials: [a], switches: [change(true)] })
    expect(result.current).not.toBe(first)
    expect(result.current[0]!.item).toBe(first[0]!.item)
    stop()
  })

  it('places each before the first message stamped after it; unstamped rows never split', () => {
    const msg = (id: string, at?: number): LogItem => ({
      kind: 'message',
      m: makeMessage(id, 'assistant', id, at === undefined ? {} : { at }),
    })
    const row = (id: string, at: number): TrialRow => ({
      kind: 'trial',
      at,
      item: card([], { id, at }),
    })
    const items = [msg('u1', 100), msg('tool'), msg('a1', 300), msg('stream')]
    const placed = placeTrialRows(items, [row('t1', 200), row('t2', 400)])
    expect(
      placed.map((i) => (i.kind === 'message' ? i.m.id : i.kind === 'trial' ? i.item.id : '?')),
    ).toEqual(['u1', 'tool', 't1', 'a1', 'stream', 't2'])
    expect(placeTrialRows(items, [])).toBe(items)
  })
})
