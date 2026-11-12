import { describe, expect, it, vi } from 'vitest'
import { canvasBoardCall, registerBoardDriver, type BoardDriver } from './board-drivers'

function driver(slug: string, page: string, shown = true): BoardDriver {
  return {
    slug,
    page,
    shown: () => shown,
    cursor: vi.fn(() => 640),
    flush: vi.fn(() => Promise.resolve()),
    boxes: () => new Map([['n1', { x: 1, y: 2, w: 3, h: 4 }]]),
    select: vi.fn(),
    view: vi.fn(() => Promise.resolve({ x: 5, y: 6, zoom: 1.5 })),
    drag: vi.fn(() => 400),
    arrange: vi.fn(() => 700),
    reveal: vi.fn(() => 420),
    landed: vi.fn(),
    goTo: vi.fn(),
  }
}

describe('canvasBoardCall', () => {
  it('answers not mounted when no board on screen shows that slug and page', async () => {
    const hidden = driver('plan', 'page-1', false)
    const other = driver('plan', 'page-2')
    const all = [hidden, other]
    expect(
      await canvasBoardCall(
        { op: 'cursor', slug: 'plan', page: 'page-1', cursor: { op: 'move' } },
        all,
      ),
    ).toEqual({ mounted: false, ms: 0 })
    expect(await canvasBoardCall({ op: 'boxes', slug: 'ideas', page: 'page-1' }, all)).toEqual({
      mounted: false,
      ms: 0,
    })
    expect(hidden.cursor).not.toHaveBeenCalled()
  })

  it('routes to the board on screen, the latest mounted when two show it', async () => {
    const older = driver('plan', 'page-1')
    const hidden = driver('plan', 'page-1', false)
    const newer = driver('plan', 'page-1')
    const all = [older, hidden, newer]
    const cursor = { op: 'move' as const, node: 'n1', anchor: 'left' as const }
    expect(
      await canvasBoardCall({ op: 'cursor', slug: 'plan', page: 'page-1', cursor }, all),
    ).toEqual({ mounted: true, ms: 640 })
    expect(newer.cursor).toHaveBeenCalledWith(cursor)
    expect(older.cursor).not.toHaveBeenCalled()
    expect(hidden.cursor).not.toHaveBeenCalled()
  })

  it('answers each op from the board: boxes, select, view, drag', async () => {
    const d = driver('plan', 'page-1')
    const at = { slug: 'plan', page: 'page-1' }
    expect(await canvasBoardCall({ op: 'boxes', ...at }, [d])).toEqual({
      mounted: true,
      boxes: { n1: { x: 1, y: 2, w: 3, h: 4 } },
    })
    expect(await canvasBoardCall({ op: 'select', ...at, ids: ['n1'] }, [d])).toEqual({
      mounted: true,
    })
    expect(d.select).toHaveBeenCalledWith(['n1'])
    expect(
      await canvasBoardCall({ op: 'view', ...at, zoom: 2, center: { x: 1, y: 1 }, duration: 300 }, [
        d,
      ]),
    ).toEqual({ mounted: true, viewport: { x: 5, y: 6, zoom: 1.5 } })
    expect(d.view).toHaveBeenCalledWith({ zoom: 2, center: { x: 1, y: 1 }, duration: 300 })
    expect(
      await canvasBoardCall({ op: 'drag', ...at, node: 'n1', to: { x: 9, y: 9 }, ms: 400 }, [d]),
    ).toEqual({ mounted: true, ms: 400 })
    expect(d.drag).toHaveBeenCalledWith('n1', { x: 9, y: 9 }, 400)
  })

  it('glides the named cards on the board on screen, and answers not mounted with none', async () => {
    const d = driver('plan', 'page-1')
    const to = { n1: { x: 10, y: 20 }, n2: { x: 300, y: 20 } }
    expect(
      await canvasBoardCall({ op: 'arrange', slug: 'plan', page: 'page-1', to, ms: 700 }, [d]),
    ).toEqual({ mounted: true, ms: 700 })
    expect(d.arrange).toHaveBeenCalledWith(to, 700)
    const hidden = driver('plan', 'page-1', false)
    expect(
      await canvasBoardCall({ op: 'arrange', slug: 'plan', page: 'page-1', to, ms: 700 }, [hidden]),
    ).toEqual({ mounted: false, ms: 0 })
    expect(hidden.arrange).not.toHaveBeenCalled()
  })

  it('reveals the drawn cards and the box together, with the context cards as the wider ask', async () => {
    const d = driver('plan', 'page-1')
    const at = { slug: 'plan', page: 'page-1' }
    expect(
      await canvasBoardCall(
        { op: 'reveal', ...at, nodes: ['n1', 'gone'], box: { x: 10, y: 20, w: 5, h: 5 } },
        [d],
      ),
    ).toEqual({ mounted: true, ms: 420 })
    expect(d.reveal).toHaveBeenLastCalledWith({ x: 1, y: 2, w: 14, h: 23 }, null)
    await canvasBoardCall(
      { op: 'reveal', ...at, box: { x: 10, y: 20, w: 5, h: 5 }, context: ['n1', 'gone'] },
      [d],
    )
    expect(d.reveal).toHaveBeenLastCalledWith(
      { x: 10, y: 20, w: 5, h: 5 },
      { x: 1, y: 2, w: 14, h: 23 },
    )
    // A flow box (a card's new spot) is a wider ask too, never the work itself.
    await canvasBoardCall(
      { op: 'reveal', ...at, nodes: ['n1'], around: { x: 10, y: 20, w: 5, h: 5 } },
      [d],
    )
    expect(d.reveal).toHaveBeenLastCalledWith(
      { x: 1, y: 2, w: 3, h: 4 },
      { x: 1, y: 2, w: 14, h: 23 },
    )
    // Nothing the board has: nothing to reveal, no wait.
    expect(
      await canvasBoardCall({ op: 'reveal', ...at, nodes: ['gone'], context: ['n1'] }, [d]),
    ).toEqual({ mounted: true, ms: 0 })
    expect(d.reveal).toHaveBeenCalledTimes(3)
  })

  it('hides the cursor and lands a carry on every mounted board of the slug, not only the one in front', async () => {
    const front = driver('plan', 'page-1')
    const hidden = driver('plan', 'page-1', false)
    const otherPage = driver('plan', 'page-2', false)
    const other = driver('ideas', 'page-1')
    const hide = { op: 'hide' as const }
    expect(
      await canvasBoardCall({ op: 'cursor', slug: 'plan', page: 'page-1', cursor: hide }, [
        front,
        hidden,
        otherPage,
        other,
      ]),
    ).toEqual({ mounted: true, ms: 640 })
    for (const d of [front, hidden, otherPage]) expect(d.cursor).toHaveBeenCalledWith(hide)
    expect(other.cursor).not.toHaveBeenCalled()
    // A landed carry stays put on a board shown later too, hidden boards included.
    expect(
      await canvasBoardCall({ op: 'landed', slug: 'plan', page: 'page-1', node: 'n1' }, [
        front,
        hidden,
        otherPage,
        other,
      ]),
    ).toEqual({ mounted: true })
    for (const d of [front, hidden, otherPage]) expect(d.landed).toHaveBeenCalledWith('n1')
    expect(other.landed).not.toHaveBeenCalled()
  })

  it('switches the board in front to the page asked for, mounted once it shows it', async () => {
    const d = driver('plan', 'page-1')
    expect(await canvasBoardCall({ op: 'page', slug: 'plan', page: 'page-2' }, [d])).toEqual({
      mounted: false,
      ms: 0,
    })
    expect(d.goTo).toHaveBeenCalledWith('page-2')
    expect(await canvasBoardCall({ op: 'page', slug: 'plan', page: 'page-1' }, [d])).toEqual({
      mounted: true,
    })
    expect(d.goTo).toHaveBeenCalledTimes(1)
  })

  it('flushes every mounted board of the slug, shown or not', async () => {
    const a = driver('plan', 'page-1', false)
    const b = driver('plan', 'page-2')
    const c = driver('ideas', 'page-1')
    expect(await canvasBoardCall({ op: 'flush', slug: 'plan' }, [a, b, c])).toEqual({
      mounted: true,
    })
    expect(a.flush).toHaveBeenCalled()
    expect(b.flush).toHaveBeenCalled()
    expect(c.flush).not.toHaveBeenCalled()
    expect(await canvasBoardCall({ op: 'flush', slug: 'gone' }, [a, b, c])).toEqual({
      mounted: false,
    })
  })

  it('routes to the registered boards until they unmount', async () => {
    const d = driver('plan', 'page-1')
    const off = registerBoardDriver(d)
    expect(
      await canvasBoardCall({ op: 'cursor', slug: 'plan', page: 'page-1', cursor: { op: 'hide' } }),
    ).toEqual({ mounted: true, ms: 640 })
    off()
    expect(
      await canvasBoardCall({ op: 'cursor', slug: 'plan', page: 'page-1', cursor: { op: 'hide' } }),
    ).toEqual({ mounted: false, ms: 0 })
  })
})
