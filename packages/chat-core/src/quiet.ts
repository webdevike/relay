import type { ChatMessage } from './message'

/** Eva's whole reply to a background line that needs nothing from Isaac (response format v2). */
export const NOTHING_TO_REPORT = '(nothing to report)'

export function isNothingToReport(text: string): boolean {
  return text.trim() === NOTHING_TO_REPORT
}

const BACKGROUND_LINE = /^\[From .+?'s background jobs\]/

/**
 * `list` without its quiet replies. A turn (a user row and everything up to the next one) whose
 * only replies are `(nothing to report)` is background noise, so its prompt, thinking and tools go
 * too; a background line that got no turn of its own (queued behind another, answered once) goes
 * with the turn that answers it. In a turn with a real reply, a silent reply is dropped alone.
 */
export function dropQuietTurns(list: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  let turn: ChatMessage[] = []
  /** Reply-less background lines waiting for the turn that answers them. */
  let held: ChatMessage[] = []
  const flush = (last: boolean): void => {
    const replies = turn.filter((m) => m.role === 'assistant')
    if (replies.length === 0) {
      if (!last && turn.length === 1 && BACKGROUND_LINE.test(turn[0]!.text)) held.push(...turn)
      else out.push(...held.splice(0), ...turn)
    } else if (replies.every((m) => isNothingToReport(m.text))) {
      held = []
    } else {
      out.push(
        ...held.splice(0),
        ...turn.filter((m) => !(m.role === 'assistant' && isNothingToReport(m.text))),
      )
    }
    turn = []
  }
  for (const m of list) {
    if (m.role === 'user') flush(false)
    turn.push(m)
  }
  flush(true)
  out.push(...held)
  return out.length === list.length ? list : out
}
