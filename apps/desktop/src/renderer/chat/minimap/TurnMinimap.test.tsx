import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import type { VListHandle } from 'virtua'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../../ipc', () => ({ invoke, on: () => () => {} }))

import { BOOKMARKS_KEY, applyHostBookmarks, reloadBookmarksForTests } from './bookmarks'
import { TurnMinimap } from './TurnMinimap'
import type { Turn } from '@evaos/chat-core/turns'

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

function setup(turns: Turn[], top = 0) {
  const jump = vi.fn()
  const watchers = new Set<() => void>()
  const list = { current: handle(top) }
  const view = render(
    <MantineProvider>
      <section data-chat-pane="p1" style={{ height: 600 }}>
        <div style={{ height: 600 }}>
          <TurnMinimap
            turns={turns}
            thread="assistant:nova"
            paneId="p1"
            listRef={list}
            subscribe={(fn) => {
              watchers.add(fn)
              return () => void watchers.delete(fn)
            }}
            jump={jump}
            shown
          />
          <textarea aria-label="composer" />
        </div>
      </section>
    </MantineProvider>,
  )
  return { jump, list, watchers, ...view }
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
    fireEvent.click(screen.getByTestId('turn-minimap-filter'))
    expect(screen.getAllByTestId('turn-tick').map((t) => t.getAttribute('data-turn'))).toEqual([
      'user@1',
      'user@3',
    ])
    fireEvent.click(screen.getByTestId('turn-minimap-filter'))
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
    fireEvent.click(screen.getByTestId('turn-minimap-filter'))
    expect(screen.queryAllByTestId('turn-tick')).toHaveLength(0)
    expect(screen.getByTestId('turn-minimap-empty')).toBeInTheDocument()
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
