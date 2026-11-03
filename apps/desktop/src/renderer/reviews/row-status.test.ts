import { describe, expect, it, vi } from 'vitest'
import type { ReviewWork } from '@evaos/contract'

vi.mock('../ipc', () => ({ invoke: vi.fn(), on: () => () => {} }))

import { rowPills, type RowStatus } from './row-status'

const work = (w: Partial<ReviewWork> = {}): ReviewWork => ({
  key: 'ENG-1',
  stage: '9 PR (draft)',
  move: 'isaac',
  phase: 'pre-review',
  loop: null,
  approve: null,
  ...w,
})
const labels = (draft: boolean, s?: RowStatus): string[] =>
  rowPills({ draft }, s).map((p) => p.label)
const gh = (
  ci: 'pass' | 'fail' | 'pending' | 'none' = 'pass',
  decision: null | 'APPROVED' = null,
) => ({
  ci,
  decision,
})

describe('row pills', () => {
  it('shows nothing before anything is read, but Draft', () => {
    expect(labels(false)).toEqual([])
    expect(labels(true)).toEqual(['Draft'])
  })

  it('a draft waiting on Isaac is Draft, CI, Approve ready', () => {
    expect(labels(true, { github: gh(), work: work({ approve: 'ready' }) })).toEqual([
      'Draft',
      'CI passing',
      'Approve ready',
    ])
  })

  it('a running self-review shows its round of 3', () => {
    const loop = { running: true, rounds: 2, outcome: null }
    expect(labels(true, { github: gh(), work: work({ loop }) })).toEqual([
      'Draft',
      'CI passing',
      'Self-review 2/3',
    ])
    expect(labels(true, { github: null, work: work({ loop: { ...loop, rounds: 0 } }) })).toContain(
      'Self-review',
    )
  })

  it('after Approve the row says Approved, not Approve ready', () => {
    expect(labels(true, { github: gh(), work: work({ approve: 'sent' }) })).toEqual([
      'Draft',
      'CI passing',
      'Approved',
    ])
  })

  it('a ready PR is In review once Astra moved on, else Ready for review', () => {
    expect(labels(false, { github: gh(), work: work({ phase: 'in-review' }) })).toEqual([
      'CI passing',
      'In review',
    ])
    expect(labels(false, { github: gh(), work: work() })).toEqual([
      'CI passing',
      'Ready for review',
    ])
  })

  it('GitHub’s decision wins on a ready PR; a PR auto-work did not open stays quiet', () => {
    expect(labels(false, { github: gh('pass', 'APPROVED'), work: work() })).toEqual([
      'CI passing',
      'Approved',
    ])
    expect(labels(false, { github: gh('none'), work: null })).toEqual([])
  })
})
