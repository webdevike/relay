import { describe, expect, it, vi } from 'vitest'
import { createActor, SimulatedClock } from 'xstate'
import { agentRunMachine, RUN_IDLE_MS, runView } from './agent-run.machine'

const nova = { id: 'nova', name: 'Nova', color: '#f0a' }
const penny = { id: 'penny', name: 'Penny', color: '#0af' }

function start() {
  const clock = new SimulatedClock()
  const fx = {
    hideCursor: vi.fn(),
    releasePending: vi.fn(),
    runPending: vi.fn(),
    resumeWaiters: vi.fn(),
  }
  const machine = agentRunMachine.provide({
    actions: {
      hideCursor: fx.hideCursor,
      releasePending: (_, params) => fx.releasePending(params),
      runPending: fx.runPending,
      resumeWaiters: fx.resumeWaiters,
    },
  })
  const actor = createActor(machine, { input: { who: nova, since: 1 }, clock }).start()
  return { actor, clock, fx, view: () => runView(actor.getSnapshot()) }
}

describe('agentRunMachine', () => {
  it('a fresh run starts its clock and caption; going on keeps both unless a caption is given', () => {
    const { actor, view } = start()
    actor.send({ type: 'run.begin', who: nova, caption: 'Laying out the plan', now: 10 })
    expect(view()).toMatchObject({ status: 'working', caption: 'Laying out the plan', since: 10 })
    actor.send({ type: 'run.begin', who: nova, now: 20 })
    expect(view()).toMatchObject({ caption: 'Laying out the plan', since: 10 })
    actor.send({ type: 'run.begin', who: nova, caption: 'Connecting', now: 30 })
    expect(view()).toMatchObject({ caption: 'Connecting', since: 10 })
  })

  it("the runtime's caption fills in but never replaces the agent's own", () => {
    const { actor, view } = start()
    actor.send({ type: 'run.begin', who: nova, now: 1 })
    actor.send({ type: 'run.caption', text: 'Adding "Plan"', auto: true })
    actor.send({ type: 'run.caption', text: 'Moving "Plan"', auto: true })
    expect(view().caption).toBe('Moving "Plan"')
    actor.send({ type: 'run.caption', text: 'Sketching options', auto: false })
    actor.send({ type: 'run.caption', text: 'Adding "B"', auto: true })
    expect(view().caption).toBe('Sketching options')
  })

  it('goes idle after a quiet spell, and each action restarts the clock', () => {
    const { actor, clock, fx, view } = start()
    actor.send({ type: 'run.begin', who: nova, caption: 'x', now: 1 })
    clock.increment(RUN_IDLE_MS - 1)
    actor.send({ type: 'run.touch' })
    clock.increment(RUN_IDLE_MS - 1)
    expect(view().status).toBe('working')
    clock.increment(1)
    expect(view()).toMatchObject({ status: 'idle', caption: '' })
    expect(fx.hideCursor).toHaveBeenCalledTimes(1)
  })

  it('take over pauses until hand back, which wakes the waiters', () => {
    const { actor, fx, view } = start()
    actor.send({ type: 'run.begin', who: nova, now: 1 })
    actor.send({ type: 'isaac.takeOver' })
    expect(view().status).toBe('paused')
    expect(fx.hideCursor).toHaveBeenCalled()
    expect(actor.getSnapshot().can({ type: 'run.begin', who: nova, now: 2 })).toBe(false)
    actor.send({ type: 'isaac.handBack' })
    expect(view().status).toBe('working')
    expect(fx.resumeWaiters).toHaveBeenCalledTimes(1)
  })

  it('an ask runs on allow, fails on deny with a stopped caption, and pauses on take over', () => {
    const a = start()
    a.actor.send({ type: 'run.begin', who: nova, now: 1 })
    a.actor.send({ type: 'run.ask', id: 'k1', label: 'place order $89.99' })
    expect(a.view()).toMatchObject({ status: 'ask', ask: { id: 'k1' } })
    a.actor.send({ type: 'isaac.allow' })
    expect(a.view()).toMatchObject({ status: 'working', ask: null })
    expect(a.fx.runPending).toHaveBeenCalledTimes(1)

    const b = start()
    b.actor.send({ type: 'run.begin', who: nova, now: 1 })
    b.actor.send({ type: 'run.ask', id: 'k2', label: 'send it' })
    b.actor.send({ type: 'isaac.deny', now: 9 })
    expect(b.view()).toMatchObject({
      status: 'stopped',
      caption: 'Stopped before: send it',
      ended: 9,
    })
    expect(b.fx.releasePending).toHaveBeenCalledWith({ paused: false })

    const c = start()
    c.actor.send({ type: 'run.begin', who: nova, now: 1 })
    c.actor.send({ type: 'run.ask', id: 'k3', label: 'delete' })
    c.actor.send({ type: 'isaac.takeOver' })
    expect(c.view()).toMatchObject({ status: 'paused', ask: null })
    expect(c.fx.releasePending).toHaveBeenCalledWith({ paused: true })
  })

  it('allow and deny mean nothing without an ask; hand back nothing unless paused', () => {
    const { actor } = start()
    actor.send({ type: 'run.begin', who: nova, now: 1 })
    const s = actor.getSnapshot()
    expect(s.can({ type: 'isaac.allow' })).toBe(false)
    expect(s.can({ type: 'isaac.deny', now: 2 })).toBe(false)
    expect(s.can({ type: 'isaac.handBack' })).toBe(false)
  })

  it('finishing settles any waiting action and ends with the summary; a new run starts fresh', () => {
    const { actor, fx, view } = start()
    actor.send({ type: 'run.begin', who: nova, now: 1 })
    actor.send({ type: 'run.ask', id: 'k', label: 'submit' })
    actor.send({ type: 'run.finish', who: nova, summary: 'Gave up', outcome: 'stopped', now: 5 })
    expect(view()).toMatchObject({ status: 'stopped', caption: 'Gave up', ended: 5, ask: null })
    expect(fx.releasePending).toHaveBeenCalledWith({ paused: false })
    actor.send({ type: 'isaac.dismiss' })
    expect(view()).toMatchObject({ status: 'idle', caption: '' })
    actor.send({ type: 'run.begin', who: penny, now: 7 })
    expect(view()).toMatchObject({ status: 'working', name: 'Penny', since: 7, ended: null })
  })
})
