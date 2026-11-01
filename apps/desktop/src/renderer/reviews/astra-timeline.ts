import type { AstraTurn } from '@evaos/contract'

/**
 * One card of an item's Astra session in its comment timeline: Isaac's private ask, or Astra's
 * reply to it (her answers with the tool lines between them). `at` is its first timed turn's.
 */
export type AstraBlock =
  | { kind: 'ask'; id: string; at?: number; turn: AstraTurn }
  | { kind: 'reply'; id: string; at?: number; turns: AstraTurn[] }

/** A row of the merged timeline: one of the item's own comments, or an Astra card. */
export type TimelineEntry<C> = { kind: 'comment'; item: C } | { kind: 'astra'; block: AstraBlock }

/**
 * The session's turns as cards: each ask its own, each run of answers and tools one reply. With
 * `pending` (she is working, waiting or failed) and no reply after the last ask yet, an empty
 * reply follows it, so her status has a card to sit in.
 */
export function astraBlocks(turns: readonly AstraTurn[], pending = false): AstraBlock[] {
  const blocks: AstraBlock[] = []
  for (const t of turns) {
    const last = blocks.at(-1)
    if (t.role === 'user') {
      blocks.push({ kind: 'ask', id: t.id, ...(t.at === undefined ? {} : { at: t.at }), turn: t })
    } else if (last?.kind === 'reply') {
      last.turns.push(t)
      if (last.at === undefined && t.at !== undefined) last.at = t.at
    } else {
      blocks.push({
        kind: 'reply',
        id: t.id,
        ...(t.at === undefined ? {} : { at: t.at }),
        turns: [t],
      })
    }
  }
  const last = blocks.at(-1)
  if (pending && last?.kind !== 'reply') {
    blocks.push({
      kind: 'reply',
      id: `${last?.id ?? 'astra'}-pending`,
      ...(last?.at === undefined ? {} : { at: last.at }),
      turns: [],
    })
  }
  return blocks
}

/**
 * The item's comments and Astra's cards in one timeline, oldest first by time. A comment comes
 * before a card at the same moment; cards without a time follow everything, in session order.
 */
export function mergeTimeline<C>(
  comments: readonly C[],
  timeOf: (c: C) => number,
  blocks: readonly AstraBlock[],
): Array<TimelineEntry<C>> {
  const rows = [
    ...comments.map((c) => ({
      at: timeOf(c),
      rank: 0,
      entry: { kind: 'comment', item: c } as const,
    })),
    ...blocks.map((b) => ({
      at: b.at ?? Infinity,
      rank: 1,
      entry: { kind: 'astra', block: b } as const,
    })),
  ]
  // Array sort is stable: equal rows keep their own order.
  rows.sort((a, b) => a.at - b.at || a.rank - b.rank)
  return rows.map((r) => r.entry)
}
