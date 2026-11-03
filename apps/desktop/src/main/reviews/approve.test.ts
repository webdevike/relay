import { describe, expect, it } from 'vitest'
import { approvableKey, approveLine, approveState, workOf } from './approve'

const PR = 'https://github.com/eCardSystems/node-client-api-service/pull/172'

const ledger = (
  over: Record<string, string> = {},
  body = '- 2026-11-03: auto-work: opened by jobs/astra-auto-work when Linear moved it',
): string => {
  const f: Record<string, string> = {
    key: 'ENG-6648',
    stage: '9 PR (draft)',
    move: 'isaac',
    pr: PR,
    ...over,
  }
  return `---\n${Object.entries(f)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\n\n## Decisions\n${body}\n`
}

describe('approve visibility', () => {
  it('shows for an auto-work ledger at 9 PR (draft) with the move on Isaac', () => {
    expect(approvableKey([{ key: 'ENG-6648', text: ledger() }], PR)).toBe('ENG-6648')
  })

  it('hides when the stage, the move, the PR or the auto-work mark differ', () => {
    const one = (text: string): string | null => approvableKey([{ key: 'ENG-6648', text }], PR)
    expect(one(ledger({ stage: '9 PR (ready)' }))).toBeNull()
    expect(one(ledger({ stage: '6 Implement' }))).toBeNull()
    expect(one(ledger({ move: 'eva' }))).toBeNull()
    expect(one(ledger({ pr: 'https://github.com/eCardSystems/x/pull/1' }))).toBeNull()
    expect(one(ledger({}, '- 2026-11-03: plan: by hand'))).toBeNull()
    expect(one(ledger({ key: 'ENG-1' }))).toBeNull()
    expect(approvableKey([], PR)).toBeNull()
  })

  it('finds the matching ledger among several', () => {
    const rows = [
      {
        key: 'ENG-1',
        text: ledger({ key: 'ENG-1', pr: 'https://github.com/eCardSystems/a/pull/1' }),
      },
      { key: 'ENG-6648', text: ledger() },
    ]
    expect(approvableKey(rows, PR)).toBe('ENG-6648')
  })

  it('is ready, sent, running or ready again after the loop ended', () => {
    expect(approveState({ loop: null, sentAt: null })).toBe('ready')
    expect(approveState({ loop: null, sentAt: 1000 })).toBe('sent')
    expect(approveState({ loop: { running: true, endedAt: null }, sentAt: 1000 })).toBe('running')
    expect(
      approveState({
        loop: { running: false, endedAt: new Date(2000).toISOString() },
        sentAt: 1000,
      }),
    ).toBe('ready')
    expect(
      approveState({
        loop: { running: false, endedAt: new Date(500).toISOString() },
        sentAt: 1000,
      }),
    ).toBe('sent')
  })
})

describe('approve hand-off', () => {
  it('tells Astra to run ready.ts approve for the key, and report', () => {
    expect(approveLine('ENG-6648')).toBe(
      'Approve request: Isaac approved the auto-work draft PR for ENG-6648 in Relay Reviews. Run `bun jobs/astra-auto-work/scripts/ready.ts ENG-6648 approve` from /Users/ike/Eva and report what it printed.',
    )
  })
})

describe('work state of a PR', () => {
  const loop = { running: true, rounds: 1, outcome: null }

  it('reads the ledger stage and move with Astra’s phase and loop', () => {
    const w = workOf(
      [{ key: 'ENG-6648', text: ledger({ stage: '9 PR (ready)', move: 'noah' }) }],
      PR,
      () => ({ phase: 'in-review', loop }),
      null,
    )
    expect(w).toEqual({
      key: 'ENG-6648',
      stage: '9 PR (ready)',
      move: 'noah',
      phase: 'in-review',
      loop,
      approve: null,
    })
  })

  it('carries the Approve state and survives a missing auto-work.json', () => {
    const w = workOf([{ key: 'ENG-6648', text: ledger() }], PR, () => null, {
      key: 'ENG-6648',
      state: 'sent',
    })
    expect(w).toMatchObject({ phase: null, loop: null, approve: 'sent' })
  })

  it('is null for a PR auto-work did not open', () => {
    expect(
      workOf([{ key: 'ENG-6648', text: ledger({}, '- hand made') }], PR, () => null, null),
    ).toBeNull()
    expect(workOf([{ key: 'ENG-6648', text: ledger() }], PR + '1', () => null, null)).toBeNull()
  })
})
