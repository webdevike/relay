import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelayFrames } from './client'
import { createHostApprove, OLD_HOST } from './host-approve'

type Frame = Record<string, unknown>

class FakeFrames implements RelayFrames {
  sent: Frame[] = []
  up = true
  private cbs = new Set<(f: Frame) => void>()
  onFrame(cb: (f: Frame) => void): () => void {
    this.cbs.add(cb)
    return () => this.cbs.delete(cb)
  }
  sendFrame(frame: Frame): boolean {
    if (!this.up) return false
    this.sent.push(frame)
    return true
  }
  hear(f: Frame): void {
    for (const cb of [...this.cbs]) cb(f)
  }
  listeners(): number {
    return this.cbs.size
  }
}

let frames: FakeFrames
beforeEach(() => {
  vi.useFakeTimers()
  frames = new FakeFrames()
})
afterEach(() => vi.useRealTimers())

describe('Approve through the Mini host', () => {
  it('asks reviews.req approvable and settles on the matching rid', async () => {
    const host = createHostApprove(frames)
    const p = host.approvable('eCardSystems/api', 172)
    const sent = frames.sent[0]!
    expect(sent).toMatchObject({
      t: 'reviews.req',
      op: { kind: 'approvable', repo: 'eCardSystems/api', number: 172 },
    })
    frames.hear({ t: 'reviews.res', rid: 'other', ok: true, approve: null })
    frames.hear({
      t: 'reviews.res',
      rid: sent.rid,
      ok: true,
      approve: { key: 'ENG-6648', state: 'ready' },
    })
    await expect(p).resolves.toEqual({ key: 'ENG-6648', state: 'ready' })
    expect(frames.listeners()).toBe(0)
  })

  it('reads a null answer as not approvable', async () => {
    const p = createHostApprove(frames).approvable('o/r', 1)
    frames.hear({ t: 'reviews.res', rid: frames.sent[0]!.rid, ok: true, approve: null })
    await expect(p).resolves.toBeNull()
  })

  it('sends approve and rejects with the host’s one-line error', async () => {
    const p = createHostApprove(frames).approve('o/r', 1)
    expect(frames.sent[0]).toMatchObject({ op: { kind: 'approve', repo: 'o/r', number: 1 } })
    frames.hear({
      t: 'reviews.res',
      rid: frames.sent[0]!.rid,
      ok: false,
      error: 'ENG-6648 was already handed to Astra',
    })
    await expect(p).rejects.toThrow('ENG-6648 was already handed to Astra')
  })

  it('rejects while not connected, and with an update hint when an old host never answers', async () => {
    frames.up = false
    await expect(createHostApprove(frames).approvable('o/r', 1)).rejects.toThrow(
      "Relay isn't connected.",
    )
    frames.up = true
    const p = createHostApprove(frames, 1000).approvable('o/r', 1)
    const caught = expect(p).rejects.toThrow(OLD_HOST)
    await vi.advanceTimersByTimeAsync(1000)
    await caught
    expect(frames.listeners()).toBe(0)
  })
})
