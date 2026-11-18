import { describe, expect, it } from 'vitest'
import { createActor, SimulatedClock } from 'xstate'
import { cardGenMachine } from './card-gen.machine'

function start() {
  const clock = new SimulatedClock()
  const actor = createActor(cardGenMachine, { clock }).start()
  const state = () => {
    const s = actor.getSnapshot()
    return s.matches('streaming') ? 'streaming' : s.value
  }
  return { clock, actor, state }
}

describe('cardGenMachine', () => {
  it('an added card spins until its first draw streams in, then settles between edits', () => {
    const { actor, state, clock } = start()
    actor.send({ type: 'agent.added' })
    expect(state()).toBe('creating')
    actor.send({ type: 'card.revealed', ms: 900 })
    expect(state()).toBe('streaming')
    // The reveal (900 ms) and its tail (600 ms); the run is still open.
    clock.increment(1_400)
    expect(state()).toBe('streaming')
    clock.increment(100)
    expect(state()).toBe('settled')
    // An edit alone shows nothing; its elements streaming in do.
    actor.send({ type: 'agent.edited' })
    expect(state()).toBe('settled')
    actor.send({ type: 'card.revealed', ms: 400 })
    expect(state()).toBe('streaming')
    clock.increment(1_200)
    expect(state()).toBe('settled')
    actor.send({ type: 'agent.finished' })
    expect(state()).toBe('idle')
  })

  it('a reveal landing on a running one keeps the light on to the end of the new one', () => {
    const { actor, state, clock } = start()
    actor.send({ type: 'agent.edited' })
    actor.send({ type: 'card.revealed', ms: 1_000 })
    clock.increment(800)
    actor.send({ type: 'card.revealed', ms: 1_000 })
    clock.increment(1_500)
    expect(state()).toBe('streaming')
    clock.increment(100)
    expect(state()).toBe('settled')
  })

  it('the run ending mid-reveal lets the reveal finish, then the card is idle', () => {
    const { actor, state, clock } = start()
    actor.send({ type: 'agent.edited' })
    actor.send({ type: 'card.revealed', ms: 1_000 })
    actor.send({ type: 'agent.finished' })
    expect(state()).toBe('streaming')
    clock.increment(1_600)
    expect(state()).toBe('idle')
  })

  it('a swap without motion still shows the label for a moment', () => {
    const { actor, state, clock } = start()
    actor.send({ type: 'agent.edited' })
    actor.send({ type: 'card.revealed', ms: 0 })
    clock.increment(1_100)
    expect(state()).toBe('streaming')
    clock.increment(100)
    expect(state()).toBe('settled')
  })

  it('a quiet spell with no edit ends the card; each edit restarts the clock', () => {
    const { actor, state, clock } = start()
    actor.send({ type: 'agent.edited' })
    clock.increment(25_000)
    actor.send({ type: 'agent.edited' })
    clock.increment(25_000)
    expect(state()).toBe('settled')
    clock.increment(5_000)
    expect(state()).toBe('idle')
  })

  it('a failed render is an error the next edit retries; the run ending leaves it', () => {
    const { actor, state, clock } = start()
    actor.send({ type: 'agent.added' })
    actor.send({ type: 'card.drawn' })
    expect(state()).toBe('settled')
    actor.send({ type: 'card.failed' })
    expect(state()).toBe('error')
    actor.send({ type: 'agent.finished' })
    clock.increment(60_000)
    expect(state()).toBe('error')
    actor.send({ type: 'agent.edited' })
    expect(state()).toBe('settled')
    actor.send({ type: 'card.revealed', ms: 300 })
    actor.send({ type: 'card.failed' })
    expect(state()).toBe('error')
    // A later draw (Isaac's undo, a fix) clears it.
    actor.send({ type: 'card.revealed', ms: 300 })
    expect(state()).toBe('streaming')
  })

  it('a card that never draws stops spinning', () => {
    const { actor, state, clock } = start()
    actor.send({ type: 'agent.added' })
    clock.increment(15_000)
    actor.send({ type: 'agent.edited' })
    clock.increment(15_000)
    expect(state()).toBe('creating')
    clock.increment(5_000)
    expect(state()).toBe('idle')
  })

  it('a card nobody works stays idle: draws, reveals, failures and finishes change nothing', () => {
    const { actor } = start()
    for (const event of [
      { type: 'card.drawn' },
      { type: 'card.revealed', ms: 500 },
      { type: 'card.failed' },
      { type: 'agent.finished' },
    ] as const) {
      expect(actor.getSnapshot().can(event)).toBe(false)
    }
  })

  it('only a card being created makes the cursor spin', () => {
    const { actor } = start()
    actor.send({ type: 'agent.added' })
    expect(actor.getSnapshot().hasTag('busy')).toBe(true)
    actor.send({ type: 'card.revealed', ms: 500 })
    expect(actor.getSnapshot().hasTag('busy')).toBe(false)
    expect(actor.getSnapshot().can({ type: 'agent.added' })).toBe(false)
  })
})
