import { describe, expect, it } from 'vitest'
import type { CanvasRun } from '@evaos/contract'
import { shownRun, takesOver } from './runs-store'

function run(slug: string, status: CanvasRun['status']): CanvasRun {
  return {
    id: 'penny',
    name: 'Penny',
    color: '#86efac',
    status,
    caption: '',
    background: false,
    ask: null,
    since: 1,
    ended: null,
    slug,
    board: 'Plan',
    page: 'page-1',
    workspace: 'page:agent:penny',
  }
}

describe('takesOver', () => {
  it("pauses the agent for Isaac's edit only while it acts or waits on his Allow", () => {
    expect(takesOver('working')).toBe(true)
    expect(takesOver('ask')).toBe(true)
    for (const s of ['paused', 'done', 'stopped', 'idle'] as const) expect(takesOver(s)).toBe(false)
    expect(takesOver(undefined)).toBe(false)
  })
})

describe('shownRun', () => {
  it("is the board's run that isn't idle", () => {
    const runs = [run('ideas', 'working'), run('plan', 'idle')]
    expect(shownRun(runs, 'plan')).toBeNull()
    expect(shownRun(runs, 'ideas')?.slug).toBe('ideas')
    expect(shownRun(runs, null)).toBeNull()
  })
})
