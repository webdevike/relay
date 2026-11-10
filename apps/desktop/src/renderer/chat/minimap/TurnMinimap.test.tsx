import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import type { VListHandle } from 'virtua'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../../ipc', () => ({ invoke, on: () => () => {} }))

import { BOOKMARKS_KEY, applyHostBookmarks, reloadBookmarksForTests } from './bookmarks'
import { TURN_RAIL_GAP, TURN_RAIL_W, TurnMinimap, turnRailFits } from './TurnMinimap'
import type { Turn } from '@evaos/chat-core/turns'
import type { OpenAsk } from '@evaos/contract'

const turn = (i: number, over: Partial<Turn> = {}): Turn => ({
  key: `user@${i}`,
  row: `u${i}`,
  item: i * 2,
  led: 'user',
  title: `Question ${i}`,
  reply: `Answer ${i} starts here.`,
  flag: null,
  ...over,
})

/** A list of 50 px rows, two per turn, scrolled to `top`. */
function handle(top: number, rows = 20): VListHandle {
  return {
    scrollOffset: top,
    viewportSize: 400,
    scrollSize: rows * 100,
    getItemOffset: (i: number) => i * 50,
  } as unknown as VListHandle
}

const ask = (id: string, question: string): OpenAsk => ({
  id,
  source: 'replies',
  label: question.slice(0, 20),
  question,
  replies: ['Yes', 'No'],
  at: 1,
})

/** Picks `mode` in the filter menu. */
function filter(mode: 'all' | 'flagged' | 'asks'): void {
  fireEvent.click(screen.getByTestId('turn-minimap-filter'))
  fireEvent.click(screen.getByTestId(`turn-minimap-show-${mode}`))
}

function setup(
  turns: Turn[],
  top = 0,
  waiting: ReadonlyMap<string, readonly OpenAsk[]> = new Map(),
  loose: readonly OpenAsk[] = [],
  fits = true,
) {
  const jump = vi.fn()
  const onJumpAsk = vi.fn(() => true)
  const onResolveAsk = vi.fn()
  const watchers = new Set<() => void>()
  const list = { current: handle(top) }
  const view = render(
    <MantineProvider env="test">
      <section data-chat-pane="p1" style={{ height: 600 }}>
        <div style={{ height: 600 }}>
          <TurnMinimap
            turns={turns}
            waiting={waiting}
            loose={loose}
            onJumpAsk={onJumpAsk}
            onResolveAsk={onResolveAsk}
            thread="assistant:nova"
            paneId="p1"
            listRef={list}
            subscribe={(fn) => {
              watchers.add(fn)
              return () => void watchers.delete(fn)
            }}
            jump={jump}
            shown
            fits={fits}
          />
          <textarea aria-label="composer" />
        </div>
      </section>
    </MantineProvider>,
  )
  return { jump, onJumpAsk, onResolveAsk, list, watchers, ...view }
}

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue({ ok: true, value: { sent: true } })
  localStorage.clear()
  reloadBookmarksForTests()
})

describe('TurnMinimap', () => {
  it('draws a tick per turn, the one on screen active', () => {
    setup(
      [0, 1, 2, 3, 4, 5].map((i) => turn(i)),
      200,
    )
    const ticks = screen.getAllByTestId('turn-tick')
    expect(ticks).toHaveLength(6)
    expect(ticks[2]).toHaveAttribute('data-state', 'active')
    expect(ticks[0]).toHaveAttribute('data-state', 'idle')
  })

  it('shows nothing for a single turn', () => {
    setup([turn(0)])
    expect(screen.queryByTestId('turn-minimap')).toBeNull()
  })

  it('hover opens the card with the message, the reply start and a flag; click jumps', () => {
    const { jump } = setup([turn(0), turn(1, { flag: 'ask' }), turn(2)])
    const ticks = screen.getAllByTestId('turn-tick')
    expect(ticks[1]).toHaveAttribute('data-flag', 'ask')
    fireEvent.mouseEnter(ticks[1]!)
    const card = screen.getByTestId('turn-card')
    expect(within(card).getByTestId('turn-card-title')).toHaveTextContent('Question 1')
    expect(within(card).getByTestId('turn-card-reply')).toHaveTextContent('Answer 1 starts here.')
    expect(within(card).getByTestId('turn-card-flag')).toHaveTextContent('Asked you something')
    fireEvent.click(ticks[1]!)
    expect(jump).toHaveBeenCalledWith(expect.objectContaining({ row: 'u1' }))
  })

  it('bookmarks from the card, persisted per thread, and the filter keeps flagged and bookmarked', () => {
    setup([turn(0), turn(1, { flag: 'shipped' }), turn(2), turn(3)])
    fireEvent.mouseEnter(screen.getAllByTestId('turn-tick')[3]!)
    fireEvent.click(screen.getByTestId('turn-card-bookmark'))
    expect(JSON.parse(localStorage.getItem(BOOKMARKS_KEY)!)).toEqual({
      'assistant:nova': ['user@3'],
    })
    expect(screen.getAllByTestId('turn-tick')[3]).toHaveAttribute('data-bookmarked', 'true')
    filter('flagged')
    expect(screen.getAllByTestId('turn-tick').map((t) => t.getAttribute('data-turn'))).toEqual([
      'user@1',
      'user@3',
    ])
    filter('all')
    expect(screen.getAllByTestId('turn-tick')).toHaveLength(4)
  })

  it('on a host that keeps bookmarks the card toggles through it, and a turn it cannot name has no toggle', () => {
    applyHostBookmarks('assistant:nova', ['user@2'])
    setup([turn(0), turn(1, { key: 'row-9' }), turn(2)])
    expect(screen.getAllByTestId('turn-tick')[2]).toHaveAttribute('data-bookmarked', 'true')
    fireEvent.mouseEnter(screen.getAllByTestId('turn-tick')[1]!)
    expect(screen.getByTestId('turn-card-bookmark')).toBeDisabled()
    fireEvent.mouseEnter(screen.getAllByTestId('turn-tick')[0]!)
    fireEvent.click(screen.getByTestId('turn-card-bookmark'))
    expect(invoke).toHaveBeenCalledWith('reactions.bookmark', {
      thread: 'assistant:nova',
      message: 'user@0',
      on: true,
    })
    expect(localStorage.getItem(BOOKMARKS_KEY)).toBeNull()
  })

  it('says so when the filter leaves nothing', () => {
    setup([turn(0), turn(1)])
    filter('flagged')
    expect(screen.queryAllByTestId('turn-tick')).toHaveLength(0)
    expect(screen.getByTestId('turn-minimap-empty')).toBeInTheDocument()
  })

  it('marks a turn holding an open ask apart from the attention dot, tells the question on its card, and Open asks keeps only those turns', () => {
    const waiting = new Map([['user@2', [ask('aaaaaaaa', 'Push it to prod?')]]])
    setup([turn(0), turn(1, { flag: 'ask' }), turn(2, { flag: 'ask' }), turn(3)], 0, waiting)
    const ticks = screen.getAllByTestId('turn-tick')
    expect(ticks.map((t) => t.getAttribute('data-waiting'))).toEqual([null, null, 'true', null])
    expect(ticks[2]!.querySelector('.eva-tm-wait')).not.toBeNull()
    expect(ticks[1]!.querySelector('.eva-tm-wait')).toBeNull()
    expect(ticks[1]!.querySelector('.eva-tm-dot')).not.toBeNull()
    expect(ticks[2]).toHaveAccessibleName('Question 2, waiting on you')
    fireEvent.mouseEnter(ticks[2]!)
    expect(screen.getByTestId('turn-card-asked')).toHaveTextContent('Push it to prod?')
    filter('asks')
    expect(screen.getAllByTestId('turn-tick').map((t) => t.getAttribute('data-turn'))).toEqual([
      'user@2',
    ])
  })

  it('a click on a ringed tick or its question jumps to the asking bubble, not the turn start; Dismiss closes the ask', () => {
    const a = ask('aaaaaaaa', 'Push it to prod?')
    const waiting = new Map([['user@2', [a]]])
    const { jump, onJumpAsk, onResolveAsk } = setup(
      [turn(0), turn(1), turn(2), turn(3)],
      0,
      waiting,
    )
    const ticks = screen.getAllByTestId('turn-tick')
    fireEvent.click(ticks[2]!)
    expect(onJumpAsk).toHaveBeenCalledWith(a)
    expect(jump).not.toHaveBeenCalled()
    fireEvent.click(ticks[1]!)
    expect(jump).toHaveBeenCalledTimes(1)
    fireEvent.mouseEnter(ticks[2]!)
    fireEvent.click(screen.getByText('Push it to prod?'))
    expect(onJumpAsk).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByTestId('turn-card-dismiss'))
    expect(onResolveAsk).toHaveBeenCalledWith(a, 'dismissed')
  })

  it('asks with no bubble sit in one entry at the end of the rail, with answers and Dismiss, and survive the Open asks filter', () => {
    const a = ask('bbbbbbbb', 'Merge it?')
    const { onResolveAsk } = setup([turn(0), turn(1)], 0, new Map(), [a])
    const end = screen.getByTestId('turn-tick-loose')
    expect(screen.getAllByTestId('turn-tick')).toHaveLength(2)
    fireEvent.mouseEnter(end)
    fireEvent.click(screen.getByRole('button', { name: 'No' }))
    expect(onResolveAsk).toHaveBeenCalledWith(a, 'answered', 'No')
    fireEvent.click(screen.getByTestId('turn-card-dismiss'))
    expect(onResolveAsk).toHaveBeenLastCalledWith(a, 'dismissed')
    filter('asks')
    expect(screen.queryAllByTestId('turn-tick')).toHaveLength(0)
    expect(screen.getByTestId('turn-tick-loose')).toBeInTheDocument()
  })

  it('shows the rail for a single turn when an ask has no bubble', () => {
    setup([turn(0)], 0, new Map(), [ask('cccccccc', 'Merge it?')])
    expect(screen.getByTestId('turn-tick-loose')).toBeInTheDocument()
  })

  it('Alt+Down and Alt+Up step to the next and previous turn, chaining rapid presses, from focus in this chat only', () => {
    const { jump } = setup(
      [0, 1, 2, 3].map((i) => turn(i)),
      100,
    )
    const box = screen.getByLabelText('composer')
    fireEvent.keyDown(box, { key: 'ArrowDown', altKey: true })
    expect(jump).toHaveBeenLastCalledWith(expect.objectContaining({ row: 'u2' }))
    // The list has not moved yet: the next step goes on from the turn just jumped to.
    fireEvent.keyDown(box, { key: 'ArrowDown', altKey: true })
    expect(jump).toHaveBeenLastCalledWith(expect.objectContaining({ row: 'u3' }))
    fireEvent.keyDown(box, { key: 'ArrowDown', altKey: true })
    expect(jump).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(box, { key: 'ArrowUp', altKey: true })
    expect(jump).toHaveBeenLastCalledWith(expect.objectContaining({ row: 'u2' }))
    jump.mockClear()
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    fireEvent.keyDown(box, { key: 'ArrowDown', altKey: true, shiftKey: true })
    fireEvent.keyDown(document.body, { key: 'ArrowDown', altKey: true })
    expect(jump).not.toHaveBeenCalled()
  })

  it('hides where the log is too narrow to keep it off the text, still stepping with Alt+Down', () => {
    const column = 780
    const need = column + 2 * (TURN_RAIL_W + TURN_RAIL_GAP)
    expect(turnRailFits(need, column)).toBe(true)
    expect(turnRailFits(need - 1, column)).toBe(false)
    const { jump } = setup(
      [0, 1, 2, 3].map((i) => turn(i)),
      0,
      new Map([['user@2', [ask('a1', 'Push it?')]]]),
      [ask('a2', 'Loose one?')],
      false,
    )
    expect(screen.queryByTestId('turn-minimap')).toBeNull()
    fireEvent.keyDown(screen.getByLabelText('composer'), { key: 'ArrowDown', altKey: true })
    expect(jump).toHaveBeenLastCalledWith(expect.objectContaining({ row: 'u1' }))
  })

  it('follows the scroll', () => {
    const { list, watchers } = setup(
      [0, 1, 2, 3, 4, 5].map((i) => turn(i)),
      0,
    )
    expect(screen.getAllByTestId('turn-tick')[0]).toHaveAttribute('data-state', 'active')
    list.current = handle(400)
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
    act(() => {
      for (const fn of watchers) fn()
      vi.advanceTimersByTime(40)
    })
    vi.useRealTimers()
    expect(screen.getAllByTestId('turn-tick')[4]).toHaveAttribute('data-state', 'active')
  })

  it('compresses thousands of turns into the ticks that fit', () => {
    setup(Array.from({ length: 4000 }, (_, i) => turn(i, i === 3000 ? { flag: 'ask' } : {})))
    const ticks = screen.getAllByTestId('turn-tick')
    expect(ticks.length).toBeLessThan(60)
    expect(ticks.filter((t) => t.hasAttribute('data-flag'))).toHaveLength(1)
  })
})
