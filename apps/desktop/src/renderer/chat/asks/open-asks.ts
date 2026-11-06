import type { OpenAsk } from '@evaos/contract'
import { turnOfItem, type Turn, type TurnRow } from '@evaos/chat-core/turns'

/** The asks still open, oldest first: `asks` without the ids Isaac closed here that the host has not dropped yet. */
export function openAsks(
  asks: readonly OpenAsk[] | null | undefined,
  closed: ReadonlySet<string>,
): OpenAsk[] {
  return (asks ?? []).filter((a) => !closed.has(a.id)).sort((a, b) => a.at - b.at)
}

/**
 * The log row an ask sits on: the bubble it names, else (a reply's ask whose id the host re-keyed)
 * the assistant bubble sent at its time. Null for an ask with no bubble: an ask card, a session's
 * question, a reply that left the thread.
 */
export function askRow(rows: readonly TurnRow[], ask: OpenAsk): TurnRow | null {
  if (ask.messageId !== undefined) {
    const named = rows.find((r) => r.id === ask.messageId)
    if (named !== undefined) return named
  }
  if (ask.source !== 'replies') return null
  return rows.find((r) => r.role === 'assistant' && r.at === ask.at) ?? null
}

/** Open ask per bubble id: the oldest when a bubble carries several. */
export function waitingRows(
  rows: readonly TurnRow[],
  asks: readonly OpenAsk[],
): ReadonlyMap<string, OpenAsk> {
  const out = new Map<string, OpenAsk>()
  for (const ask of asks) {
    const row = askRow(rows, ask)
    if (row !== null && !out.has(row.id)) out.set(row.id, ask)
  }
  return out
}

/** The asks with no bubble in the log (a session's question, an ask card): the rail's end entry holds them. */
export function looseAsks(rows: readonly TurnRow[], asks: readonly OpenAsk[]): OpenAsk[] {
  return asks.filter((a) => askRow(rows, a) === null)
}

/** Open asks by the turn that holds their bubble (its key); asks with no bubble are `looseAsks`. */
export function waitingTurns(
  turns: readonly Turn[],
  rows: readonly TurnRow[],
  asks: readonly OpenAsk[],
): ReadonlyMap<string, readonly OpenAsk[]> {
  const out = new Map<string, OpenAsk[]>()
  if (turns.length === 0) return out
  for (const ask of asks) {
    const row = askRow(rows, ask)
    if (row === null) continue
    const key = turns[turnOfItem(turns, row.index)]!.key
    const held = out.get(key)
    if (held === undefined) out.set(key, [ask])
    else held.push(ask)
  }
  return out
}
