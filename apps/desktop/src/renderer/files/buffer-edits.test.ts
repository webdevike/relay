import { describe, expect, it } from 'vitest'
import { lineEdits, rebase, type TextEdit } from './buffer-edits'

function apply(text: string, edits: readonly TextEdit[]): string {
  let out = text
  for (const e of [...edits].reverse()) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

describe('lineEdits', () => {
  it('rebuilds the new text from per-block edits, at the start, middle and end', () => {
    const cases: Array<[string, string]> = [
      ['a\nb\nc', 'a\nB\nc'],
      ['a\nb\nc', 'x\na\nb\nc'],
      ['a\nb\nc', 'a\nb\nc\nd'],
      ['a\nb\nc\n', 'a\nb\nc\nd\n'],
      ['a\nb\nc', 'a'],
      ['a\nb\nc', ''],
      ['', 'new'],
      ['a\r\nb\r\nc', 'a\r\nB\r\nc'],
      ['1\n2\n3\n4\n5\n6\n7\n8', '1\nTWO\n3\n4\n5\n6\nSEVEN\n8'],
    ]
    for (const [a, b] of cases) expect(apply(a, lineEdits(a, b))).toBe(b)
  })

  it('touches only the changed lines, so a caret elsewhere keeps its offset', () => {
    const before = 'keep 1\nchange me\nkeep 2\nkeep 3'
    const edits = lineEdits(before, 'keep 1\nchanged\nkeep 2\nkeep 3')
    expect(edits).toEqual([{ start: 7, end: 17, text: 'changed\n' }])
  })
})

describe('rebase (the unsaved-merge rule)', () => {
  const base = 'a\nb\nc\nd'
  it('a clean buffer takes the disk text', () => {
    expect(rebase(base, true, base, 'a\nB\nc\nd')).toEqual({
      ok: true,
      text: 'a\nB\nc\nd',
      dirty: false,
    })
  })
  it('unsaved edits elsewhere are kept and stay unsaved', () => {
    expect(rebase('A\nb\nc\nd', false, base, 'a\nb\nc\nD')).toEqual({
      ok: true,
      text: 'A\nb\nc\nD',
      dirty: true,
    })
  })
  it('unsaved edits that match the disk are clean again', () => {
    expect(rebase('a\nB\nc\nd', false, base, 'a\nB\nc\nd')).toEqual({
      ok: true,
      text: 'a\nB\nc\nd',
      dirty: false,
    })
  })
  it('an overlapping change is refused, leaving the buffer alone', () => {
    expect(rebase('a\nmine\nc\nd', false, base, 'a\ntheirs\nc\nd')).toEqual({ ok: false })
  })
})
