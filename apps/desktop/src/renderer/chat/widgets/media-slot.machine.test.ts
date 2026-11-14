import { describe, expect, it } from 'vitest'
import { createActor, fromCallback, SimulatedClock } from 'xstate'
import { mediaSlotMachine, type MediaLane, type MediaSlotEvent } from './media-slot.machine'

/** A ticket that records its asks and releases; `grant()` answers the latest ask. */
function harness(evict: boolean) {
  const log: string[] = []
  let grant: (() => void) | null = null
  const clock = new SimulatedClock()
  const machine = mediaSlotMachine.provide({
    actors: {
      ticket: fromCallback<MediaSlotEvent, { lane: MediaLane; rank: number }>(
        ({ sendBack, input }) => {
          log.push(`ask ${input.lane}@${input.rank}`)
          grant = () => sendBack({ type: 'slot.granted' })
          return () => log.push('release')
        },
      ),
    },
  })
  const actor = createActor(machine, { input: { lane: 'model', rank: 7, evict }, clock }).start()
  return { actor, log, clock, grant: () => grant?.() }
}

const value = (a: { getSnapshot(): { value: unknown } }) => JSON.stringify(a.getSnapshot().value)

describe('mediaSlotMachine', () => {
  it('asks only once near, loads when granted and frees the slot once settled', () => {
    const h = harness(true)
    expect(h.log).toEqual([])
    h.actor.send({ type: 'slot.near' })
    expect(h.log).toEqual(['ask model@7'])
    expect(h.actor.getSnapshot().hasTag('live')).toBe(false)
    h.grant()
    expect(h.actor.getSnapshot().hasTag('live')).toBe(true)
    h.actor.send({ type: 'slot.settled' })
    expect(value(h.actor)).toBe('"shown"')
    expect(h.log).toEqual(['ask model@7', 'release'])
    expect(h.actor.getSnapshot().hasTag('live')).toBe(true)
  })

  it('drops its place in line when it leaves the near margin before its turn', () => {
    const h = harness(false)
    h.actor.send({ type: 'slot.near' })
    h.actor.send({ type: 'slot.away' })
    expect(value(h.actor)).toBe('"away"')
    expect(h.log).toEqual(['ask model@7', 'release'])
  })

  it('a load that never settles gives its slot up after LOAD_TIMEOUT and stays shown', () => {
    const h = harness(false)
    h.actor.send({ type: 'slot.near' })
    h.grant()
    h.clock.increment(15_000)
    expect(value(h.actor)).toBe('"shown"')
    expect(h.log.at(-1)).toBe('release')
  })

  it('an evicting viewer unloads far off screen and asks again when it comes back', () => {
    const h = harness(true)
    h.actor.send({ type: 'slot.near' })
    h.grant()
    h.actor.send({ type: 'slot.far' })
    expect(value(h.actor)).toBe('"away"')
    expect(h.actor.getSnapshot().hasTag('live')).toBe(false)
    h.actor.send({ type: 'slot.near' })
    expect(h.log).toEqual(['ask model@7', 'release', 'ask model@7'])
  })

  it('an image stays shown far off screen', () => {
    const h = harness(false)
    h.actor.send({ type: 'slot.near' })
    h.grant()
    h.actor.send({ type: 'slot.settled' })
    expect(h.actor.getSnapshot().can({ type: 'slot.far' })).toBe(false)
  })
})
