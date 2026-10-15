import { describe, expect, it } from 'vitest'
import { sessionId } from './session-id'

describe('sessionId', () => {
  it('comes from file names (ported Rust test)', () => {
    expect(
      sessionId('/s/2026-10-02T23-30-41-963Z_01a0fef4-a8ab-7656-b9f4-010bd783beb1.jsonl'),
    ).toBe('01a0fef4-a8ab-7656-b9f4-010bd783beb1')
    expect(sessionId('/p/661b1670-51dd-4f31-9780-590cb2c28147.jsonl')).toBe(
      '661b1670-51dd-4f31-9780-590cb2c28147',
    )
    expect(sessionId('/s/notes.jsonl')).toBe('notes')
  })
  it('handles short ids', () => {
    expect(sessionId('/x/2026-10-02T23-30-41-963Z_3f2a.jsonl')).toBe('3f2a')
    expect(sessionId('/x/7c1e-uuid.jsonl')).toBe('7c1e-uuid')
  })
})
