import { describe, expect, it } from 'vitest'
import { awayOf, awaySignature } from './away'
import type { RelaySession, RelayStatus } from './feed'

const s = (status: RelayStatus, extra: Partial<RelaySession> = {}): RelaySession => ({
  id: 'a',
  status,
  detail: null,
  canRespond: true,
  kind: 'manual',
  title: '',
  assistant: null,
  activity: null,
  activityAt: null,
  ...extra,
})

describe('awayOf', () => {
  it('maps each Relay status the way native Activity::Away reads', () => {
    expect(awayOf(s('working', { detail: 'bash' }))).toEqual({
      phase: 'working',
      working: true,
      dialog: null,
      job: false,
    })
    expect(awayOf(s('needs_permission'))).toMatchObject({ phase: 'blocked', dialog: 'confirm' })
    expect(awayOf(s('waiting'))).toMatchObject({ phase: 'blocked', dialog: 'other' })
    expect(awayOf(s('idle', { kind: 'job' }))).toEqual({
      phase: 'idle',
      working: false,
      dialog: null,
      job: true,
    })
    // Ended and unlisted sessions are not running.
    expect(awayOf(s('ended'))).toBeNull()
    expect(awayOf(undefined)).toBeNull()
  })

  it("omp's ask tool still reads Working on the row, but blocks the order", () => {
    expect(awayOf(s('working', { detail: 'ask' }))).toEqual({
      phase: 'blocked',
      working: true,
      dialog: null,
      job: false,
    })
  })
})

describe('awaySignature', () => {
  const map = (...list: RelaySession[]) => new Map(list.map((x) => [x.id, x]))

  it('changes only with what the list shows', () => {
    const base = awaySignature(map(s('working', { detail: 'bash' })))
    expect(awaySignature(map(s('working', { detail: 'read', title: 'T' })))).toBe(base)
    expect(awaySignature(map(s('working', { detail: 'ask' })))).not.toBe(base)
    expect(awaySignature(map(s('idle')))).not.toBe(base)
    // An ended session reads like an unlisted one; down differs from connected and empty.
    expect(awaySignature(map(s('ended')))).toBe(awaySignature(map()))
    expect(awaySignature(null)).not.toBe(awaySignature(map()))
  })
})
