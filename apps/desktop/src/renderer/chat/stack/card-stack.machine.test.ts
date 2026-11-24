import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import { cardStackMachine } from './card-stack.machine'

const start = (ids: readonly string[] = [], loop = false) =>
  createActor(cardStackMachine, { input: { loop, ids } }).start()

describe('card stack machine', () => {
  it('shows a tab once a card arrives, and none once the last one leaves, even while open', () => {
    const stack = start()
    expect(stack.getSnapshot().value).toBe('empty')
    expect(stack.getSnapshot().can({ type: 'stack.open' })).toBe(false)
    stack.send({ type: 'cards.changed', ids: ['q1', 'run1'] })
    expect(stack.getSnapshot().value).toBe('collapsed')
    expect(stack.getSnapshot().context.front).toBe('q1')
    stack.send({ type: 'stack.open', id: 'q1' })
    expect(stack.getSnapshot().value).toBe('expanded')
    expect(stack.getSnapshot().context.front).toBe('q1')
    stack.send({ type: 'cards.changed', ids: [] })
    expect(stack.getSnapshot().value).toBe('empty')
    expect(stack.getSnapshot().context.front).toBeNull()
  })

  it('starts collapsed on the first card when it already has cards', () => {
    const stack = start(['q1', 'q2'])
    expect(stack.getSnapshot().value).toBe('collapsed')
    expect(stack.getSnapshot().context.front).toBe('q1')
  })

  it('steps only while open: the closed tab cannot move', () => {
    const stack = start(['a', 'b', 'c'])
    expect(stack.getSnapshot().can({ type: 'stack.step', by: 1 })).toBe(false)
    stack.send({ type: 'stack.open' })
    stack.send({ type: 'stack.step', by: 1 })
    stack.send({ type: 'stack.step', by: 1 })
    stack.send({ type: 'stack.step', by: 1 })
    expect(stack.getSnapshot().context).toMatchObject({ front: 'c', dir: 1 })
    stack.send({ type: 'stack.show', id: 'a' })
    expect(stack.getSnapshot().context).toMatchObject({ front: 'a', dir: -1 })
  })

  it('loops past the last card when it is a carousel (the phone)', () => {
    const stack = start(['a', 'b'], true)
    stack.send({ type: 'stack.open' })
    stack.send({ type: 'stack.step', by: -1 })
    expect(stack.getSnapshot().context.front).toBe('b')
  })

  it('moves the front to the next card when the front one is answered, and remembers it was answered here', () => {
    const stack = start(['a', 'b', 'c'])
    stack.send({ type: 'stack.open', id: 'b' })
    stack.send({ type: 'card.answered', id: 'b' })
    expect(stack.getSnapshot().context.answered).toBe('b')
    stack.send({ type: 'cards.changed', ids: ['a', 'c'] })
    expect(stack.getSnapshot().value).toBe('expanded')
    expect(stack.getSnapshot().context).toMatchObject({ front: 'c', answered: null })
  })

  it('collapses back to the same front card', () => {
    const stack = start(['a', 'b'])
    stack.send({ type: 'stack.open', id: 'b' })
    stack.send({ type: 'stack.collapse' })
    expect(stack.getSnapshot().value).toBe('collapsed')
    expect(stack.getSnapshot().context.front).toBe('b')
  })
})
