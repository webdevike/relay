import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelayFrames } from './client'
import { createHostReviews, OLD_HOST } from './host-reviews'

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

describe('Reviews through the Mini host', () => {
  it('sends reviews.req and settles on the matching rid with the answer fields', async () => {
    const host = createHostReviews(frames)
    const p = host.req({ kind: 'approvable', repo: 'eCardSystems/api', number: 172 })
    const sent = frames.sent[0]!
    expect(sent).toMatchObject({
      t: 'reviews.req',
      op: { kind: 'approvable', repo: 'eCardSystems/api', number: 172 },
    })
    // Another rid is not ours.
    frames.hear({ t: 'reviews.res', rid: 'other', ok: true, approve: null })
    frames.hear({
      t: 'reviews.res',
      rid: sent.rid,
      ok: true,
      approve: { key: 'ENG-1', state: 'ready' },
    })
    await expect(p).resolves.toEqual({ approve: { key: 'ENG-1', state: 'ready' } })
    expect(frames.listeners()).toBe(0)
  })

  it('rejects with the host’s one-line error', async () => {
    const p = createHostReviews(frames).req({ kind: 'pr', repo: 'o/r', number: 1 })
    frames.hear({
      t: 'reviews.res',
      rid: frames.sent[0]!.rid,
      ok: false,
      error: 'gh pr view failed: Could not resolve to a PullRequest',
    })
    await expect(p).rejects.toThrow('gh pr view failed: Could not resolve to a PullRequest')
  })

  it('rejects while not connected, and with an update hint when an old host never answers', async () => {
    frames.up = false
    await expect(createHostReviews(frames).req({ kind: 'queue', refresh: false })).rejects.toThrow(
      "Relay isn't connected.",
    )
    frames.up = true
    const p = createHostReviews(frames, () => 1000).req({ kind: 'prList', list: 'created' })
    const caught = expect(p).rejects.toThrow(OLD_HOST)
    await vi.advanceTimersByTimeAsync(1000)
    await caught
    expect(frames.listeners()).toBe(0)
  })

  it('passes the queue and Astra pushes on, nothing else', () => {
    const heard: Frame[] = []
    const off = createHostReviews(frames).onPush((f) => heard.push(f))
    frames.hear({ t: 'reviews.queue', queue: {} })
    frames.hear({ t: 'reviews.astra', item: {} })
    frames.hear({ t: 'agents.delta' })
    off()
    frames.hear({ t: 'reviews.queue', queue: {} })
    expect(heard.map((f) => f.t)).toEqual(['reviews.queue', 'reviews.astra'])
  })
})
