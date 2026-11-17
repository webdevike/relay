import { describe, expect, it } from 'vitest'
import { SimulatedClock } from 'xstate'
import {
  createShareSnapshots,
  parseShareEvent,
  type ShareCommand,
  type ShareFrame,
} from './share-snapshots'

const HASH = 'f'.repeat(64)

function harness() {
  const commands: ShareCommand[] = []
  const frames: ShareFrame[] = []
  const clock = new SimulatedClock()
  const shots = createShareSnapshots({
    id: 'm1',
    percent: 6,
    sendHelper: (cmd) => commands.push(cmd),
    sendFrame: (frame) => frames.push(frame),
    clock,
  })
  return { shots, commands, frames, clock }
}

describe('share snapshots runtime', () => {
  it('parses the helper share events and nothing else', () => {
    expect(parseShareEvent('{"ev":"share","id":"m1","state":"on","permission":true}')).toEqual({
      ev: 'share',
      id: 'm1',
      state: 'on',
      permission: true,
    })
    expect(parseShareEvent(`{"ev":"share.sampled","id":"m1","seq":2,"hash":"${HASH}"}`)).toEqual({
      ev: 'share.sampled',
      id: 'm1',
      seq: 2,
      hash: HASH,
    })
    expect(parseShareEvent('{"ev":"share.saved","id":"m1","seq":2,"n":4}')).toMatchObject({ n: 4 })
    expect(parseShareEvent('{"ev":"stopped","id":"m1"}')).toBeNull()
    expect(parseShareEvent('{"ev":"share","id":"m1","state":"maybe","permission":true}')).toBeNull()
    expect(parseShareEvent('nope')).toBeNull()
  })

  it('turns helper events into commands and host frames for its recording only', () => {
    const h = harness()
    h.shots.heard({ ev: 'share', id: 'other', state: 'on', permission: true })
    expect(h.frames).toEqual([])
    h.shots.heard({ ev: 'share', id: 'm1', state: 'on', permission: true })
    expect(h.frames).toEqual([{ t: 'meeting.share', id: 'm1', state: 'sharing' }])
    h.clock.increment(3_000)
    expect(h.commands).toEqual([{ cmd: 'share.sample', id: 'm1', seq: 1 }])
    h.shots.heard({ ev: 'share.sampled', id: 'm1', seq: 1, hash: HASH })
    expect(h.commands.at(-1)).toEqual({ cmd: 'share.save', id: 'm1', seq: 1 })
    h.shots.heard({ ev: 'share.saved', id: 'm1', seq: 1, n: 1 })
    // A raised threshold makes a fully changed picture the only one worth saving.
    h.shots.setPercent(50)
    h.clock.increment(3_000)
    h.shots.heard({ ev: 'share.sampled', id: 'm1', seq: 2, hash: 'f'.repeat(40) + '0'.repeat(24) })
    expect(h.commands).toHaveLength(3)
    h.shots.heard({ ev: 'share', id: 'm1', state: 'on', permission: false })
    expect(h.frames.at(-1)).toEqual({ t: 'meeting.share', id: 'm1', state: 'no-permission' })
  })

  it('says the share state again when asked (a host that came back), none included', () => {
    const h = harness()
    h.shots.resend()
    expect(h.frames).toEqual([{ t: 'meeting.share', id: 'm1', state: 'none' }])
    h.shots.heard({ ev: 'share', id: 'm1', state: 'on', permission: false })
    h.shots.resend()
    expect(h.frames.slice(1)).toEqual([
      { t: 'meeting.share', id: 'm1', state: 'no-permission' },
      { t: 'meeting.share', id: 'm1', state: 'no-permission' },
    ])
    h.shots.heard({ ev: 'share', id: 'm1', state: 'on', permission: true })
    h.shots.resend()
    expect(h.frames.slice(3)).toEqual([
      { t: 'meeting.share', id: 'm1', state: 'sharing' },
      { t: 'meeting.share', id: 'm1', state: 'sharing' },
    ])
    h.shots.heard({ ev: 'share', id: 'm1', state: 'off', permission: true })
    h.shots.resend()
    expect(h.frames.slice(5)).toEqual([
      { t: 'meeting.share', id: 'm1', state: 'none' },
      { t: 'meeting.share', id: 'm1', state: 'none' },
    ])
    // Stopped: nothing more, not even on a resend.
    h.shots.stop()
    h.shots.resend()
    expect(h.frames).toHaveLength(7)
  })

  it('stop tells the host nobody shares and asks nothing more', () => {
    const h = harness()
    h.shots.heard({ ev: 'share', id: 'm1', state: 'on', permission: true })
    h.shots.stop()
    expect(h.frames.at(-1)).toEqual({ t: 'meeting.share', id: 'm1', state: 'none' })
    h.clock.increment(60_000)
    h.shots.heard({ ev: 'share', id: 'm1', state: 'on', permission: true })
    expect(h.commands).toEqual([])
    expect(h.frames).toHaveLength(2)
  })
})
