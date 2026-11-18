import { describe, expect, it } from 'vitest'
import { createActor, SimulatedClock } from 'xstate'
import { protoFrameMachine } from './proto-frame.machine'

/** The machine with `post` recording what the page was sent. */
function harness(source = 'A') {
  const posts: string[] = []
  const clock = new SimulatedClock()
  const machine = protoFrameMachine.provide({
    actions: { post: ({ context }) => posts.push(`${context.rev}:${context.latest}`) },
  })
  const actor = createActor(machine, { input: { source }, clock }).start()
  const answer = (rev: number, ok: boolean, error?: string) =>
    actor.send({ type: 'frame.rendered', rev, ok, error })
  const state = () => actor.getSnapshot().value
  const ctx = () => actor.getSnapshot().context
  return { actor, posts, clock, answer, state, ctx }
}

describe('protoFrameMachine', () => {
  it('boots with the card code, then sends each edit as a new revision without a reboot', () => {
    const h = harness('A')
    expect(h.state()).toBe('booting')
    h.answer(0, true)
    expect(h.state()).toBe('live')
    h.actor.send({ type: 'source.changed', source: 'B' })
    expect(h.state()).toBe('rendering')
    expect(h.posts).toEqual(['1:B'])
    h.answer(1, true)
    expect(h.state()).toBe('live')
    expect(h.ctx()).toMatchObject({ good: 'B', boot: 0, error: null })
  })

  it('keeps the last good code when a revision does not draw, and recovers on the next', () => {
    const h = harness('A')
    h.answer(0, true)
    h.actor.send({ type: 'source.changed', source: 'A<' })
    h.answer(1, false, 'does not compile: Unexpected token')
    expect(h.state()).toBe('failed')
    expect(h.actor.getSnapshot().hasTag('error')).toBe(true)
    expect(h.ctx()).toMatchObject({ good: 'A', error: 'does not compile: Unexpected token' })
    h.actor.send({ type: 'source.changed', source: 'C' })
    h.answer(2, true)
    expect(h.state()).toBe('live')
    expect(h.ctx()).toMatchObject({ good: 'C', error: null })
  })

  it('ignores answers for revisions it already replaced', () => {
    const h = harness('A')
    h.answer(0, true)
    h.actor.send({ type: 'source.changed', source: 'B' })
    h.actor.send({ type: 'source.changed', source: 'C' })
    expect(h.posts).toEqual(['1:B', '2:C'])
    h.answer(1, false, 'stale')
    expect(h.state()).toBe('rendering')
    h.answer(2, true)
    expect(h.ctx()).toMatchObject({ good: 'C', error: null })
  })

  it('sends the newest code once a page that booted with older code answers', () => {
    const h = harness('A')
    h.actor.send({ type: 'source.changed', source: 'B' })
    expect(h.posts).toEqual([])
    h.answer(0, true)
    expect(h.posts).toEqual(['1:B'])
    expect(h.ctx().good).toBe('A')
  })

  it('reboots a page that stops answering, from the last good code', () => {
    const h = harness('A')
    h.answer(0, true)
    h.actor.send({ type: 'source.changed', source: 'B' })
    h.clock.increment(5_000)
    expect(h.state()).toBe('booting')
    expect(h.ctx()).toMatchObject({ boot: 1, bootSource: 'A', rev: 0, latest: 'B' })
    h.answer(0, true)
    expect(h.posts).toEqual(['1:B', '1:B'])
  })

  it('a new theme boots a fresh page from the last good code', () => {
    const h = harness('A')
    h.answer(0, true)
    h.actor.send({ type: 'source.changed', source: 'bad' })
    h.answer(1, false, 'nope')
    h.actor.send({ type: 'frame.reboot' })
    expect(h.state()).toBe('booting')
    expect(h.ctx()).toMatchObject({ boot: 1, bootSource: 'A' })
  })

  it('fails a page that never loads', () => {
    const h = harness('A')
    h.clock.increment(15_000)
    expect(h.state()).toBe('failed')
    expect(h.ctx().error).toBe('The page did not load')
  })

  it('refuses a same-code edit: nothing is sent', () => {
    const h = harness('A')
    h.answer(0, true)
    expect(h.actor.getSnapshot().can({ type: 'source.changed', source: 'A' })).toBe(false)
  })
})
