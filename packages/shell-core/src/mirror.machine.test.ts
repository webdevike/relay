import { describe, expect, it } from 'vitest'
import { createActor, SimulatedClock } from 'xstate'
import { MIRROR_ACK_MS, workspaceMirrorMachine, type MirrorPut } from './mirror.machine'
import type { Entries } from './mirror'

function start(entries: Entries = {}) {
  const gets: number[] = []
  const puts: MirrorPut[] = []
  const applied: Array<{ set: Entries; del: string[] }> = []
  const clock = new SimulatedClock()
  const machine = workspaceMirrorMachine.provide({
    actions: {
      sendGet: () => {
        gets.push(1)
      },
      sendPut: (_, p) => {
        puts.push(p)
      },
      applyEntries: (_, p) => {
        applied.push(p)
      },
    },
  })
  const actor = createActor(machine, { input: { origin: 'mac-a', entries }, clock }).start()
  return { actor, gets, puts, applied, clock, ctx: () => actor.getSnapshot().context }
}

describe('workspaceMirrorMachine', () => {
  it('seeds a host that holds nothing with every local entry', () => {
    const m = start({ tabs: 1, 'layout:a': { x: 1 } })
    m.actor.send({ type: 'host.up' })
    expect(m.gets).toHaveLength(1)
    m.actor.send({ type: 'host.state', rev: 0, entries: {} })
    expect(m.puts).toEqual([
      { rid: 'mac-a-1', set: { tabs: 1, 'layout:a': { x: 1 } }, del: [], seed: true },
    ])
    m.actor.send({ type: 'host.ack', rid: 'mac-a-1', rev: 1, applied: true })
    expect(m.actor.getSnapshot().matches({ live: 'idle' })).toBe(true)
    expect(m.ctx().synced).toEqual(m.ctx().local)
  })

  it('adopts a host that holds entries, and a refused seed adopts the state that follows', () => {
    const m = start({ tabs: 1 })
    m.actor.send({ type: 'host.up' })
    m.actor.send({ type: 'host.state', rev: 0, entries: {} })
    // Another Mac seeded first.
    m.actor.send({ type: 'host.ack', rid: 'mac-a-1', rev: 4, applied: false })
    expect(m.actor.getSnapshot().matches('joining')).toBe(true)
    m.actor.send({ type: 'host.state', rev: 4, entries: { tabs: 2, 'page:t1': { url: 'u' } } })
    expect(m.applied).toEqual([{ set: { tabs: 2, 'page:t1': { url: 'u' } }, del: [] }])
    expect(m.ctx().local).toEqual({ tabs: 2, 'page:t1': { url: 'u' } })
    expect(m.puts).toHaveLength(1)
    expect(m.actor.getSnapshot().matches({ live: 'idle' })).toBe(true)
  })

  it('a change made while offline survives the join and goes up', () => {
    const m = start({ tabs: 1, order: ['a'] })
    m.actor.send({ type: 'local.changed', entries: { tabs: 5, order: ['a'] } })
    m.actor.send({ type: 'host.up' })
    m.actor.send({ type: 'host.state', rev: 9, entries: { tabs: 3, order: ['b'] } })
    // The host's order shows; this Mac's tabs stay and go up.
    expect(m.applied).toEqual([{ set: { order: ['b'] }, del: [] }])
    expect(m.puts.at(-1)).toMatchObject({ set: { tabs: 5 }, del: [], seed: false })
  })

  it('shows another Mac change and sends nothing back for its echo', () => {
    const m = start({ tabs: 1 })
    m.actor.send({ type: 'host.up' })
    m.actor.send({ type: 'host.state', rev: 2, entries: { tabs: 1 } })
    m.actor.send({ type: 'host.changed', rev: 3, origin: 'mac-b', set: { tabs: 7 }, del: [] })
    expect(m.applied.at(-1)).toEqual({ set: { tabs: 7 }, del: [] })
    // The window shows it and reports it back: no put.
    m.actor.send({ type: 'local.changed', entries: { tabs: 7 } })
    expect(m.puts).toEqual([])
    expect(m.ctx().rev).toBe(3)
  })

  it('a local change in flight wins over a concurrent remote change to the same key', () => {
    const m = start({ tabs: 1, order: ['a'] })
    m.actor.send({ type: 'host.up' })
    m.actor.send({ type: 'host.state', rev: 1, entries: { tabs: 1, order: ['a'] } })
    m.actor.send({ type: 'local.changed', entries: { tabs: 2, order: ['a'] } })
    expect(m.puts).toEqual([{ rid: 'mac-a-1', set: { tabs: 2 }, del: [], seed: false }])
    // The other Mac's put reached the host first: rev 2; ours is rev 3.
    m.actor.send({
      type: 'host.changed',
      rev: 2,
      origin: 'mac-b',
      set: { tabs: 9, order: ['b'] },
      del: [],
    })
    expect(m.applied.at(-1)).toEqual({ set: { order: ['b'] }, del: [] })
    expect(m.ctx().local).toEqual({ tabs: 2, order: ['b'] })
    m.actor.send({ type: 'host.ack', rid: 'mac-a-1', rev: 3, applied: true })
    expect(m.ctx().synced).toEqual({ tabs: 2, order: ['b'] })
    expect(m.puts).toHaveLength(1)
  })

  it('local changes while a put is out go in the next put', () => {
    const m = start({})
    m.actor.send({ type: 'host.up' })
    m.actor.send({ type: 'host.state', rev: 1, entries: { a: 1 } })
    m.actor.send({ type: 'local.changed', entries: { a: 2 } })
    m.actor.send({ type: 'local.changed', entries: { a: 2, b: 1 } })
    expect(m.puts).toHaveLength(1)
    m.actor.send({ type: 'host.ack', rid: 'mac-a-1', rev: 2, applied: true })
    expect(m.puts[1]).toEqual({ rid: 'mac-a-2', set: { b: 1 }, del: [], seed: false })
    m.actor.send({ type: 'local.changed', entries: { b: 1 } })
    m.actor.send({ type: 'host.ack', rid: 'mac-a-2', rev: 3, applied: true })
    expect(m.puts[2]).toEqual({ rid: 'mac-a-3', set: {}, del: ['a'], seed: false })
  })

  it('a skipped rev asks for the whole state again; an old one is ignored', () => {
    const m = start({})
    m.actor.send({ type: 'host.up' })
    m.actor.send({ type: 'host.state', rev: 5, entries: { a: 1 } })
    m.actor.send({ type: 'host.changed', rev: 5, origin: 'x', set: { a: 3 }, del: [] })
    expect(m.ctx().local).toEqual({ a: 1 })
    m.actor.send({ type: 'host.changed', rev: 8, origin: 'x', set: { a: 2 }, del: [] })
    expect(m.actor.getSnapshot().matches('joining')).toBe(true)
    expect(m.gets).toHaveLength(2)
  })

  it('a lost ack rejoins after the timeout; going down waits offline', () => {
    const m = start({})
    m.actor.send({ type: 'host.up' })
    m.actor.send({ type: 'host.state', rev: 1, entries: {} })
    m.actor.send({ type: 'local.changed', entries: { a: 1 } })
    m.clock.increment(MIRROR_ACK_MS)
    expect(m.actor.getSnapshot().matches('joining')).toBe(true)
    expect(m.gets).toHaveLength(2)
    m.actor.send({ type: 'host.down' })
    expect(m.actor.getSnapshot().matches('offline')).toBe(true)
    // A stale state from before the drop is not adopted.
    m.actor.send({ type: 'host.state', rev: 9, entries: { a: 5 } })
    expect(m.actor.getSnapshot().matches('offline')).toBe(true)
    expect(
      m.actor.getSnapshot().can({ type: 'host.ack', rid: 'mac-a-1', rev: 1, applied: true }),
    ).toBe(false)
  })
})
