import { describe, expect, it } from 'vitest'
import { createActor, SimulatedClock } from 'xstate'
import { cardGenMachine } from './card-gen.machine'

function start() {
  const clock = new SimulatedClock()
  const actor = createActor(cardGenMachine, { clock }).start()
  return { clock, actor, state: () => actor.getSnapshot().value }
}

describe('cardGenMachine', () => {
  it('an added card spins until it first draws, then generates through edits until canvas.done', () => {
    const { actor, state, clock } = start()
    actor.send({ type: 'agent.added' })
    expect(state()).toBe('creating')
    actor.send({ type: 'card.drawn' })
    expect(state()).toBe('generating')
    actor.send({ type: 'agent.edited' })
    actor.send({ type: 'card.drawn' })
    expect(state()).toBe('generating')
    actor.send({ type: 'agent.finished' })
    expect(state()).toBe('done')
    clock.increment(4_000)
    expect(state()).toBe('idle')
  })

  it('each edit restarts the quiet clock; a quiet spell with no edit is done', () => {
    const { actor, state, clock } = start()
    actor.send({ type: 'agent.edited' })
    clock.increment(25_000)
    actor.send({ type: 'agent.edited' })
    clock.increment(25_000)
    expect(state()).toBe('generating')
    clock.increment(5_000)
    expect(state()).toBe('done')
  })

  it('a failed render is an error the next edit retries; it never finishes as done', () => {
    const { actor, state, clock } = start()
    actor.send({ type: 'agent.added' })
    actor.send({ type: 'card.drawn' })
    actor.send({ type: 'card.failed' })
    expect(state()).toBe('error')
    // The run ending leaves the error showing; no clock clears it.
    actor.send({ type: 'agent.finished' })
    clock.increment(60_000)
    expect(state()).toBe('error')
    actor.send({ type: 'agent.edited' })
    expect(state()).toBe('generating')
    actor.send({ type: 'card.failed' })
    expect(state()).toBe('error')
    // A later draw (Isaac's undo, a fix) clears it.
    actor.send({ type: 'card.drawn' })
    expect(state()).toBe('done')
  })

  it('a card that never draws stops spinning', () => {
    const { actor, state, clock } = start()
    actor.send({ type: 'agent.added' })
    clock.increment(15_000)
    actor.send({ type: 'agent.edited' })
    clock.increment(15_000)
    expect(state()).toBe('creating')
    clock.increment(5_000)
    expect(state()).toBe('done')
  })

  it('a card nobody works stays idle: draws, failures and finishes change nothing', () => {
    const { actor } = start()
    for (const type of ['card.drawn', 'card.failed', 'agent.finished'] as const) {
      expect(actor.getSnapshot().can({ type })).toBe(false)
    }
  })

  it('only a card being created makes the cursor spin', () => {
    const { actor } = start()
    actor.send({ type: 'agent.added' })
    expect(actor.getSnapshot().hasTag('busy')).toBe(true)
    actor.send({ type: 'card.drawn' })
    expect(actor.getSnapshot().hasTag('busy')).toBe(false)
    expect(actor.getSnapshot().can({ type: 'agent.added' })).toBe(false)
  })
})
