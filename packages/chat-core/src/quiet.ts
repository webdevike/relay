import type { ChatMessage } from './message'

/** Eva's whole reply to a background line that needs nothing from Isaac (response format v2). */
export const NOTHING_TO_REPORT = '(nothing to report)'

export function isNothingToReport(text: string): boolean {
  return text.trim() === NOTHING_TO_REPORT
}

/**
 * `list` without its quiet turns: a turn (a user row and everything up to the next one) whose
 * only reply is `(nothing to report)` is background noise, so its prompt, thinking and tools go too.
 * A turn another assistant popped into (guest rows) still shows, minus that reply: Isaac sees who
 * came and what they said or took on, even when the host assistant had nothing to add.
 */
export function dropQuietTurns(list: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  let turn: ChatMessage[] = []
  const flush = (): void => {
    const replies = turn.filter((m) => m.role === 'assistant')
    const quiet = replies.length > 0 && replies.every((m) => isNothingToReport(m.text))
    if (!quiet) out.push(...turn)
    else if (turn.some((m) => m.role === 'guest'))
      out.push(...turn.filter((m) => m.role !== 'assistant'))
    turn = []
  }
  for (const m of list) {
    if (m.role === 'user') flush()
    turn.push(m)
  }
  flush()
  return out.length === list.length ? list : out
}
