import { describe, expect, it } from 'vitest'
import { carryOf, layersFor, readBoardCarry, registerBoardCarry } from './handoff'
import { routeOf } from '../comment-model'
import { agentsOf } from '../../chat/composer/at-menu'

describe('carryOf', () => {
  it('keeps the page, the view, the selected cards and the open thread', () => {
    const carry = carryOf({
      page: 'page-2',
      viewport: { x: -120, y: 40.5, zoom: 0.8 },
      nodes: [{ id: 'a', selected: true }, { id: 'b' }, { id: 'c', selected: true }],
      thread: 't1',
    })
    expect(carry).toEqual({
      page: 'page-2',
      viewport: { x: -120, y: 40.5, zoom: 0.8 },
      selection: ['a', 'c'],
      thread: 't1',
    })
  })
})

describe('the board registered for a room to take over', () => {
  it('is read live, only for its own board, and gone once unregistered', () => {
    let page = 'page-1'
    const off = registerBoardCarry('mind-map', () =>
      carryOf({ page, viewport: null, nodes: [], thread: null }),
    )
    expect(readBoardCarry('mind-map')?.page).toBe('page-1')
    page = 'page-3'
    expect(readBoardCarry('mind-map')?.page).toBe('page-3')
    expect(readBoardCarry('other')).toBeNull()
    off()
    expect(readBoardCarry('mind-map')).toBeNull()
  })
})

describe('layersFor', () => {
  it('shows the board alone until a room appears', () => {
    expect(layersFor({ slug: 'm', room: null, boardWasUp: true, positioned: null })).toEqual({
      board: true,
      live: false,
      covered: false,
    })
  })
  it('keeps the board up with the room loading behind it, then swaps once positioned', () => {
    const loading = layersFor({ slug: 'm', room: 'r1', boardWasUp: true, positioned: null })
    expect(loading).toEqual({ board: true, live: true, covered: true })
    const swapped = layersFor({ slug: 'm', room: 'r1', boardWasUp: true, positioned: 'r1' })
    expect(swapped).toEqual({ board: false, live: true, covered: false })
    // Once swapped the board is not brought back by the flag it set itself.
    expect(layersFor({ slug: 'm', room: 'r1', boardWasUp: false, positioned: 'r1' }).board).toBe(
      false,
    )
  })
  it('waits again for a second room, and shows a room that opens with no board before it', () => {
    expect(layersFor({ slug: 'm', room: 'r2', boardWasUp: true, positioned: 'r1' }).covered).toBe(
      true,
    )
    expect(layersFor({ slug: 'm', room: 'r1', boardWasUp: false, positioned: null })).toEqual({
      board: false,
      live: true,
      covered: false,
    })
    expect(layersFor({ slug: null, room: 'r1', boardWasUp: true, positioned: null }).live).toBe(
      false,
    )
  })
})

describe('comment routing on the Canvas page', () => {
  const agents = [
    { id: 'astra', title: 'Astra', scope: 'eCard Systems work' },
    { id: 'nova', title: 'Nova', scope: '' },
  ]
  const candidates = agentsOf(agents)
  it('lists the registry', () => {
    expect(candidates).toEqual([
      { id: 'astra', name: 'Astra', hint: 'eCard Systems work' },
      { id: 'nova', name: 'Nova' },
    ])
  })
  it('sends a comment to the agent it names, and a reply to the thread’s agent', () => {
    expect(routeOf('Can you check this, @astra?', candidates, null)).toEqual({
      assignee: 'astra',
      mentioned: true,
    })
    expect(routeOf('and the footer', candidates, 'astra')).toEqual({
      assignee: 'astra',
      mentioned: false,
    })
    expect(routeOf('@nova instead', candidates, 'astra')).toEqual({
      assignee: 'nova',
      mentioned: true,
    })
    expect(routeOf('a plain note', candidates, null)).toEqual({ assignee: null, mentioned: false })
  })
})
