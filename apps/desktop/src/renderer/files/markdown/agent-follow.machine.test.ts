import { describe, expect, it, vi } from 'vitest'
import { createActor, SimulatedClock } from 'xstate'
import { agentFollowMachine, ISAAC_GRACE_MS } from './agent-follow.machine'

const NOVA = { name: 'Nova', color: '#12b886', line: 40 }

function start() {
  const reveal = vi.fn()
  const clock = new SimulatedClock()
  const actor = createActor(
    agentFollowMachine.provide({ actions: { reveal: (_, p: { line: number }) => reveal(p.line) } }),
    { clock },
  ).start()
  return { actor, reveal, clock }
}

describe('agentFollowMachine', () => {
  it('an edit on screen just shows, the view stays', () => {
    const { actor, reveal } = start()
    actor.send({ type: 'agent.edited', agent: NOVA, side: null })
    expect(actor.getSnapshot().matches({ agent: 'inView' })).toBe(true)
    expect(reveal).not.toHaveBeenCalled()
  })

  it('an edit off screen scrolls into view while Isaac is idle', () => {
    const { actor, reveal } = start()
    actor.send({ type: 'agent.edited', agent: NOVA, side: 'below' })
    expect(reveal).toHaveBeenCalledWith(40)
    expect(actor.getSnapshot().matches({ agent: 'inView' })).toBe(true)
  })

  it('while Isaac works his view never moves: a pill says where, and goes there on a click', () => {
    const { actor, reveal } = start()
    actor.send({ type: 'isaac.active' })
    actor.send({ type: 'agent.edited', agent: NOVA, side: 'below' })
    const snap = actor.getSnapshot()
    expect(snap.matches({ agent: 'offScreen' })).toBe(true)
    expect(snap.context.agent).toMatchObject({ name: 'Nova', side: 'below', line: 40 })
    expect(reveal).not.toHaveBeenCalled()
    actor.send({ type: 'agent.jump' })
    expect(reveal).toHaveBeenCalledWith(40)
    expect(actor.getSnapshot().matches({ agent: 'inView' })).toBe(true)
    expect(actor.getSnapshot().context.agent?.side).toBeNull()
  })

  it(`Isaac counts as working for ${String(ISAAC_GRACE_MS)} ms after his last input`, () => {
    const { actor, reveal, clock } = start()
    actor.send({ type: 'isaac.active' })
    clock.increment(ISAAC_GRACE_MS - 100)
    actor.send({ type: 'isaac.active' })
    clock.increment(ISAAC_GRACE_MS - 100)
    actor.send({ type: 'agent.edited', agent: NOVA, side: 'above' })
    expect(reveal).not.toHaveBeenCalled()
    clock.increment(200)
    expect(actor.getSnapshot().matches({ isaac: 'idle' })).toBe(true)
    actor.send({ type: 'agent.edited', agent: { ...NOVA, line: 3 }, side: 'above' })
    expect(reveal).toHaveBeenCalledWith(3)
  })

  it('the agent leaves when its marks fade; nothing to jump to then', () => {
    const { actor } = start()
    actor.send({ type: 'isaac.active' })
    actor.send({ type: 'agent.edited', agent: NOVA, side: 'below' })
    actor.send({ type: 'agent.left' })
    const snap = actor.getSnapshot()
    expect(snap.matches({ agent: 'none' })).toBe(true)
    expect(snap.context.agent).toBeNull()
    expect(snap.can({ type: 'agent.jump' })).toBe(false)
  })
})
