import { describe, expect, it } from 'vitest'
import { CHAT_STATUSES, STATUS_LABEL, rowStatus } from './status'

const base = { owned: false, working: false, dialog: null, jobs: 0 } as const

describe('status', () => {
  it('labels are the Rust words sentence-cased with no em dash', () => {
    expect(STATUS_LABEL).toEqual({
      open: 'Open',
      working: 'Working',
      'needs-approval': 'Needs approval',
      'has-question': 'Has a question',
      job: 'Job',
    })
    for (const s of CHAT_STATUSES) expect(STATUS_LABEL[s]).not.toContain('—')
  })
  it('precedence', () => {
    expect(rowStatus({ ...base, owned: true, working: true, dialog: 'confirm' })).toBe(
      'needs-approval',
    )
    expect(rowStatus({ ...base, owned: true, dialog: 'other' })).toBe('has-question')
    expect(rowStatus({ ...base, owned: true, working: true })).toBe('working')
    expect(rowStatus({ ...base, owned: true, jobs: 2 })).toBe('job')
    expect(rowStatus({ ...base, owned: true })).toBe('open')
    expect(rowStatus(base)).toBeNull()
  })
})
