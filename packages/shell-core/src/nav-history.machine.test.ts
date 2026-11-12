import { describe, expect, it, vi } from 'vitest'
import { SimulatedClock, createActor } from 'xstate'
import { NAV_RESTORE_MS, NAV_SETTLE_MS, navHistoryMachine, placeOf, type Spot } from './index'

const chat = (n: number): Spot => ({
  ws: `chat:${n}`,
  tab: 1,
  place: placeOf('chat', { chat: `${n}.jsonl` }),
  front: null,
  scroll: null,
})
const settings = (section: 'Theme' | 'Chat'): Spot => ({
  ws: 'settings',
  tab: 1,
  place: placeOf('settings', { settingsSection: section }),
  front: null,
  scroll: null,
})

function start() {
  const restore = vi.fn()
  const clock = new SimulatedClock()
  const actor = createActor(
    navHistoryMachine.provide({ actions: { restore: (_, p) => restore(p.spot) } }),
    {
      clock,
    },
  ).start()
  const goto = (spot: Spot): void => {
    actor.send({ type: 'spot.changed', spot })
    clock.increment(NAV_SETTLE_MS)
  }
  const chats = (): (string | null)[] =>
    actor.getSnapshot().context.history.entries.map((s) => s.place.chat)
  return { actor, clock, restore, goto, chats }
}

describe('navHistory machine', () => {
  it('records the first spot at once and later ones after they settle', () => {
    const { actor, clock } = start()
    actor.send({ type: 'spot.changed', spot: chat(1) })
    expect(actor.getSnapshot().context.history.entries).toHaveLength(1)
    actor.send({ type: 'spot.changed', spot: chat(2) })
    expect(actor.getSnapshot().value).toBe('settling')
    expect(actor.getSnapshot().context.history.entries).toHaveLength(1)
    clock.increment(NAV_SETTLE_MS)
    expect(actor.getSnapshot().value).toBe('watching')
    expect(actor.getSnapshot().context.history.entries).toHaveLength(2)
  })

  it('coalesces a flicker: A to B to C inside the settle time records only C', () => {
    const { actor, clock, goto, chats } = start()
    goto(chat(1))
    actor.send({ type: 'spot.changed', spot: chat(2) })
    clock.increment(NAV_SETTLE_MS - 50)
    actor.send({ type: 'spot.changed', spot: chat(3) })
    clock.increment(NAV_SETTLE_MS - 50)
    expect(chats()).toEqual(['1.jsonl'])
    clock.increment(50)
    expect(chats()).toEqual(['1.jsonl', '3.jsonl'])
  })

  it('records nothing for a flicker that comes back to where Isaac was', () => {
    const { actor, goto, chats, clock } = start()
    goto(chat(1))
    actor.send({ type: 'spot.changed', spot: chat(2) })
    actor.send({ type: 'spot.changed', spot: chat(1) })
    clock.increment(NAV_SETTLE_MS * 2)
    expect(chats()).toEqual(['1.jsonl'])
    expect(actor.getSnapshot().value).toBe('watching')
  })

  it('goes back three times to the chat Isaac started from, then forward again', () => {
    const { actor, restore, goto } = start()
    goto(chat(1))
    goto(settings('Theme'))
    goto(settings('Chat'))
    goto({ ws: 'board', tab: 1, place: placeOf('board:main'), front: null, scroll: null })
    for (let i = 0; i < 3; i++) actor.send({ type: 'history.back' })
    expect(restore).toHaveBeenLastCalledWith(chat(1))
    expect(actor.getSnapshot().value).toBe('restoring')
    actor.send({ type: 'history.forward' })
    expect(restore).toHaveBeenLastCalledWith(settings('Theme'))
  })

  it('records a step that comes while a spot is still settling', () => {
    const { actor, restore, goto, chats } = start()
    goto(chat(1))
    actor.send({ type: 'spot.changed', spot: chat(2) })
    actor.send({ type: 'history.back' })
    expect(restore).toHaveBeenCalledWith(chat(1))
    expect(chats()).toEqual(['1.jsonl', '2.jsonl'])
    expect(actor.getSnapshot().context.history.index).toBe(0)
  })

  it('ignores the echo of a step: spots seen while restoring are not new entries', () => {
    const { actor, clock, goto, chats } = start()
    goto(chat(1))
    goto(chat(2))
    actor.send({ type: 'history.back' })
    actor.send({ type: 'spot.changed', spot: settings('Theme') })
    actor.send({ type: 'spot.changed', spot: chat(1) })
    clock.increment(NAV_RESTORE_MS)
    expect(actor.getSnapshot().value).toBe('watching')
    expect(chats()).toEqual(['1.jsonl', '2.jsonl'])
    expect(actor.getSnapshot().context.history.index).toBe(0)
  })

  it('adopts where a step really ended when its tab was gone', () => {
    const { actor, clock, goto } = start()
    goto(chat(1))
    goto(chat(2))
    actor.send({ type: 'history.back' })
    const landed = { ...chat(1), tab: 7 }
    actor.send({ type: 'spot.changed', spot: landed })
    clock.increment(NAV_RESTORE_MS)
    expect(actor.getSnapshot().context.history.entries[0]).toEqual(landed)
  })

  it('a new place after stepping back drops the forward entries', () => {
    const { actor, clock, goto, chats } = start()
    goto(chat(1))
    goto(chat(2))
    goto(chat(3))
    actor.send({ type: 'history.back' })
    clock.increment(NAV_RESTORE_MS)
    goto(chat(9))
    expect(chats()).toEqual(['1.jsonl', '2.jsonl', '9.jsonl'])
    expect(actor.getSnapshot().can({ type: 'history.forward' })).toBe(false)
  })

  it('cannot step past either end, and the list jumps straight to an entry', () => {
    const { actor, restore, goto } = start()
    expect(actor.getSnapshot().can({ type: 'history.back' })).toBe(false)
    goto(chat(1))
    goto(chat(2))
    goto(chat(3))
    expect(actor.getSnapshot().can({ type: 'history.forward' })).toBe(false)
    actor.send({ type: 'history.jump', index: 0 })
    expect(restore).toHaveBeenLastCalledWith(chat(1))
    expect(actor.getSnapshot().can({ type: 'history.back' })).toBe(false)
    expect(actor.getSnapshot().can({ type: 'history.jump', index: 7 })).toBe(false)
  })
})
