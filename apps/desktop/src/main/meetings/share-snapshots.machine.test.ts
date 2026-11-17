import { describe, expect, it } from 'vitest'
import { createActor, SimulatedClock } from 'xstate'
import { hashDistance, shareSnapshotsMachine } from './share-snapshots.machine'

/** A hash with the first `bits` bits set (0 is all zeros). */
function hashWith(bits: number): string {
  const bin = '1'.repeat(bits).padEnd(256, '0')
  let hex = ''
  for (let i = 0; i < 256; i += 4) hex += parseInt(bin.slice(i, i + 4), 2).toString(16)
  return hex
}

/** The machine with its commands and reports written to `log`. */
function harness(percent = 6) {
  const log: string[] = []
  const clock = new SimulatedClock()
  const machine = shareSnapshotsMachine.provide({
    actions: {
      askSample: (_, { seq }) => log.push(`sample ${seq}`),
      askSave: (_, { seq }) => log.push(`save ${seq}`),
      reportShare: (_, { state }) => log.push(`share ${state}`),
      warn: (_, { message }) => log.push(`warn ${message}`),
    },
  })
  const actor = createActor(machine, { input: { percent }, clock }).start()
  return { actor, log, clock }
}

const value = (a: { getSnapshot(): { value: unknown } }) => JSON.stringify(a.getSnapshot().value)

describe('shareSnapshotsMachine', () => {
  it('counts the bits two hashes differ in', () => {
    expect(hashDistance(hashWith(0), hashWith(0))).toBe(0)
    expect(hashDistance(hashWith(0), hashWith(37))).toBe(37)
    expect(hashDistance(hashWith(256), hashWith(0))).toBe(256)
  })

  it('samples every 3 s while sharing and the first sample always saves', () => {
    const h = harness()
    h.actor.send({ type: 'share.on', permission: true })
    expect(h.log).toEqual(['share sharing'])
    h.clock.increment(2_999)
    expect(h.log).toEqual(['share sharing'])
    h.clock.increment(1)
    expect(h.log).toEqual(['share sharing', 'sample 1'])
    h.actor.send({ type: 'share.sampled', seq: 1, hash: hashWith(0) })
    expect(h.log.at(-1)).toBe('save 1')
    h.actor.send({ type: 'share.saved', seq: 1, n: 1 })
    expect(value(h.actor)).toBe('{"sharing":"waiting"}')
    expect(h.actor.getSnapshot().context.savedHash).toBe(hashWith(0))
    h.clock.increment(3_000)
    expect(h.log.at(-1)).toBe('sample 2')
  })

  it('skips a sample below the threshold and saves one above it', () => {
    const h = harness(6)
    h.actor.send({ type: 'share.on', permission: true })
    h.clock.increment(3_000)
    h.actor.send({ type: 'share.sampled', seq: 1, hash: hashWith(0) })
    h.actor.send({ type: 'share.saved', seq: 1, n: 1 })
    // 15 of 256 bits is under 6%.
    h.clock.increment(3_000)
    h.actor.send({ type: 'share.sampled', seq: 2, hash: hashWith(15) })
    expect(value(h.actor)).toBe('{"sharing":"waiting"}')
    expect(h.log).not.toContain('save 2')
    // 16 of 256 is just over.
    h.clock.increment(3_000)
    h.actor.send({ type: 'share.sampled', seq: 3, hash: hashWith(16) })
    expect(h.log.at(-1)).toBe('save 3')
    h.actor.send({ type: 'share.saved', seq: 3, n: 2 })
    expect(h.actor.getSnapshot().context.savedHash).toBe(hashWith(16))
  })

  it('a threshold change takes effect at the next sample', () => {
    const h = harness(6)
    h.actor.send({ type: 'share.on', permission: true })
    h.clock.increment(3_000)
    h.actor.send({ type: 'share.sampled', seq: 1, hash: hashWith(0) })
    h.actor.send({ type: 'share.saved', seq: 1, n: 1 })
    h.actor.send({ type: 'share.threshold', percent: 5 })
    h.clock.increment(3_000)
    h.actor.send({ type: 'share.sampled', seq: 2, hash: hashWith(13) })
    expect(h.log.at(-1)).toBe('save 2')
    h.actor.send({ type: 'share.save.failed', seq: 2, reason: 'disk' })
    h.actor.send({ type: 'share.threshold', percent: 50 })
    h.clock.increment(3_000)
    h.actor.send({ type: 'share.sampled', seq: 3, hash: hashWith(100) })
    expect(h.log).not.toContain('save 3')
  })

  it('ignores answers to an older ask', () => {
    const h = harness()
    h.actor.send({ type: 'share.on', permission: true })
    h.clock.increment(3_000)
    h.clock.increment(10_000)
    expect(h.log.at(-1)).toBe('warn share sample timed out')
    h.clock.increment(3_000)
    expect(h.log.at(-1)).toBe('sample 2')
    expect(h.actor.getSnapshot().can({ type: 'share.sampled', seq: 1, hash: hashWith(0) })).toBe(
      false,
    )
    h.actor.send({ type: 'share.sampled', seq: 1, hash: hashWith(0) })
    expect(value(h.actor)).toBe('{"sharing":"sampling"}')
    h.actor.send({ type: 'share.sampled', seq: 2, hash: hashWith(0) })
    expect(h.log.at(-1)).toBe('save 2')
    h.actor.send({ type: 'share.saved', seq: 1, n: 9 })
    expect(value(h.actor)).toBe('{"sharing":"saving"}')
  })

  it('goes back to waiting after a failed or timed out sample or save', () => {
    const h = harness()
    h.actor.send({ type: 'share.on', permission: true })
    h.clock.increment(3_000)
    h.actor.send({ type: 'share.sample.failed', seq: 1, reason: 'no window' })
    expect(value(h.actor)).toBe('{"sharing":"waiting"}')
    h.clock.increment(3_000)
    h.actor.send({ type: 'share.sampled', seq: 2, hash: 'not a hash' })
    expect(value(h.actor)).toBe('{"sharing":"waiting"}')
    h.clock.increment(3_000)
    h.actor.send({ type: 'share.sampled', seq: 3, hash: hashWith(0) })
    h.clock.increment(30_000)
    expect(value(h.actor)).toBe('{"sharing":"waiting"}')
    // Nothing was saved, so the next sample saves too.
    expect(h.actor.getSnapshot().context.savedHash).toBeNull()
    h.clock.increment(3_000)
    h.actor.send({ type: 'share.sampled', seq: 4, hash: hashWith(0) })
    expect(h.log.at(-1)).toBe('save 4')
    expect(h.log.filter((l) => l.startsWith('warn'))).toEqual([
      'warn share sample failed: no window',
      'warn share sample has an unreadable hash: not a hash',
      'warn share save timed out',
    ])
  })

  it('waits without capturing while Screen Recording is not allowed', () => {
    const h = harness()
    h.actor.send({ type: 'share.on', permission: false })
    expect(value(h.actor)).toBe('"blocked"')
    h.clock.increment(10_000)
    expect(h.log).toEqual(['share no-permission'])
    h.actor.send({ type: 'share.on', permission: true })
    expect(h.log.at(-1)).toBe('share sharing')
    h.clock.increment(3_000)
    expect(h.log.at(-1)).toBe('sample 1')
    h.actor.send({ type: 'share.on', permission: false })
    expect(value(h.actor)).toBe('"blocked"')
    h.actor.send({ type: 'share.off' })
    expect(h.log).toEqual([
      'share no-permission',
      'share sharing',
      'sample 1',
      'share no-permission',
      'share none',
    ])
  })

  it('a share that ends mid-save drops the answer and the next share saves its first sample', () => {
    const h = harness()
    h.actor.send({ type: 'share.on', permission: true })
    h.clock.increment(3_000)
    h.actor.send({ type: 'share.sampled', seq: 1, hash: hashWith(0) })
    h.actor.send({ type: 'share.saved', seq: 1, n: 1 })
    h.clock.increment(3_000)
    h.actor.send({ type: 'share.sampled', seq: 2, hash: hashWith(200) })
    expect(h.log.at(-1)).toBe('save 2')
    h.actor.send({ type: 'share.off' })
    h.actor.send({ type: 'share.saved', seq: 2, n: 2 })
    expect(value(h.actor)).toBe('"idle"')
    h.clock.increment(30_000)
    expect(h.log.at(-1)).toBe('share none')
    h.actor.send({ type: 'share.on', permission: true })
    expect(h.actor.getSnapshot().context.savedHash).toBeNull()
    h.clock.increment(3_000)
    h.actor.send({ type: 'share.sampled', seq: 3, hash: hashWith(0) })
    expect(h.log.at(-1)).toBe('save 3')
  })

  it('a share already on stays on when the helper repeats it', () => {
    const h = harness()
    h.actor.send({ type: 'share.on', permission: true })
    h.clock.increment(3_000)
    h.actor.send({ type: 'share.on', permission: true })
    expect(value(h.actor)).toBe('{"sharing":"sampling"}')
    expect(h.log).toEqual(['share sharing', 'sample 1'])
  })

  it('stop ends everything: the host hears none and nothing more is asked', () => {
    const h = harness()
    h.actor.send({ type: 'share.on', permission: true })
    h.clock.increment(3_000)
    h.actor.send({ type: 'share.stop' })
    expect(h.actor.getSnapshot().status).toBe('done')
    expect(h.log).toEqual(['share sharing', 'sample 1', 'share none'])
    h.clock.increment(60_000)
    h.actor.send({ type: 'share.on', permission: true })
    expect(h.log).toEqual(['share sharing', 'sample 1', 'share none'])
  })

  it('stopping with no share reports nothing', () => {
    const h = harness()
    h.actor.send({ type: 'share.stop' })
    expect(h.log).toEqual([])
  })
})
