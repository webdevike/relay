import { describe, expect, it } from 'vitest'
import { MediaQueue } from './media-queue'

const tick = (): Promise<void> => Promise.resolve()

describe('MediaQueue', () => {
  it('grants the newest ranks first, at most `limit` at once', async () => {
    const q = new MediaQueue(2)
    const granted: string[] = []
    const release: Record<string, () => void> = {}
    // Asked in document order (oldest message first), as one observer callback delivers them.
    for (const [name, rank] of [
      ['m1', 1],
      ['m2', 2],
      ['m3', 3],
      ['m4', 4],
    ] as const)
      release[name] = q.enqueue(rank, () => granted.push(name))
    await tick()
    expect(granted).toEqual(['m4', 'm3'])
    release['m4']!()
    await tick()
    expect(granted).toEqual(['m4', 'm3', 'm2'])
  })

  it('among equal ranks, the later ask goes first', async () => {
    const q = new MediaQueue(1)
    const granted: string[] = []
    q.enqueue(5, () => granted.push('top'))
    q.enqueue(5, () => granted.push('bottom'))
    await tick()
    expect(granted).toEqual(['bottom'])
  })

  it('a released waiting ask is never granted, and releasing twice frees one slot', async () => {
    const q = new MediaQueue(1)
    const granted: string[] = []
    const a = q.enqueue(3, () => granted.push('a'))
    const b = q.enqueue(2, () => granted.push('b'))
    const c = q.enqueue(1, () => granted.push('c'))
    await tick()
    b()
    a()
    a()
    await tick()
    expect(granted).toEqual(['a', 'c'])
    c()
    const d = q.enqueue(0, () => granted.push('d'))
    const e = q.enqueue(0, () => granted.push('e'))
    await tick()
    // One slot: the double release of `a` did not open a second one.
    expect(granted).toEqual(['a', 'c', 'e'])
    d()
    e()
  })
})
