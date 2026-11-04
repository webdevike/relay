import { diffLines, merge3 } from '@relay/protocol/text-diff'

/** Replace characters `[start, end)` of the old text with `text`. */
export interface TextEdit {
  start: number
  end: number
  text: string
}

/**
 * The edits that turn `before` into `after`, one per changed block of lines, as character
 * offsets into `before`: applied to an editor buffer they leave every caret and selection
 * outside the changed lines where it was (one whole-buffer replace would move them all).
 */
export function lineEdits(before: string, after: string): TextEdit[] {
  const old = before.split('\n')
  const starts: number[] = []
  let at = 0
  for (const line of old) {
    starts.push(at)
    at += line.length + 1
  }
  const n = old.length
  return diffLines(old, after.split('\n')).map((h) => {
    const startOf = (i: number): number => (i < n ? (starts[i] as number) : before.length)
    if (h.baseEnd < n) {
      return {
        start: startOf(h.baseStart),
        end: startOf(h.baseEnd),
        text: h.lines.map((l) => `${l}\n`).join(''),
      }
    }
    // The block reaches the last line, which has no newline after it.
    if (h.lines.length > 0) {
      return h.baseStart < n
        ? { start: startOf(h.baseStart), end: before.length, text: h.lines.join('\n') }
        : { start: before.length, end: before.length, text: `\n${h.lines.join('\n')}` }
    }
    // Cutting the last lines takes the newline before them too.
    return { start: Math.max(0, startOf(h.baseStart) - 1), end: before.length, text: '' }
  })
}

/**
 * What an open buffer becomes when its file goes from `base` to `next` on disk. A clean buffer
 * (`ours` is `base`) takes `next`. Unsaved edits are merged with the change line by line and
 * stay unsaved (`dirty`) unless the merge is exactly `next`; a change that overlaps them is not
 * taken at all (`ok: false`): Isaac's typing is never overwritten.
 */
export function rebase(
  ours: string,
  clean: boolean,
  base: string,
  next: string,
): { ok: true; text: string; dirty: boolean } | { ok: false } {
  if (clean) return { ok: true, text: next, dirty: false }
  const merged = merge3(base, ours, next)
  return merged.ok ? { ok: true, text: merged.text, dirty: merged.text !== next } : { ok: false }
}
