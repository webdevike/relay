import type { AstraTurn } from '@evaos/contract'

/**
 * One entry under a private Astra thread's root: Isaac's reply typed in the thread, or Astra's
 * reply (her answers with the tool lines between them). `at` is its first timed turn's.
 */
export type AstraBlock =
  | { kind: 'ask'; id: string; at?: number; turn: AstraTurn }
  | { kind: 'reply'; id: string; at?: number; turns: AstraTurn[] }

/**
 * A private thread: Isaac's @Astra comment from the item's composer as its root, then the replies
 * in it, his (typed in the thread's own reply box) and hers. All of an item's threads are turns of
 * the item's one Astra session.
 */
export interface AstraThread {
  id: string
  at?: number
  root: AstraTurn
  replies: AstraBlock[]
  /** It holds the session's newest ask: her working, waiting and error state show in it. */
  newest?: true
}

/** A row of the merged timeline: one of the item's own comments, or an Astra thread. */
export type TimelineEntry<C> = { kind: 'comment'; item: C } | { kind: 'astra'; thread: AstraThread }

/** How a reply typed in a thread names its thread to the session (and to the phone, which reads the same turns). */
const REPLY = /^\(Reply in your thread on "([^"\n]*)"\)\n/

/** The root's words as a reply's first line names them. */
export function threadSnippet(root: string): string {
  return root.replace(/\s+/g, ' ').replace(/"/g, "'").trim().slice(0, 80)
}

/** What a reply typed in the thread on `root` sends: the line naming the thread, then the text. */
export function threadReplyText(root: string, text: string): string {
  return `(Reply in your thread on "${threadSnippet(root)}")\n${text}`
}

/**
 * The session's turns as private threads: each ask from the item's composer a root, each ask
 * that names a thread (`threadReplyText`) a reply in it, and her answers and tools a reply in the
 * thread of the ask before them. With `pending` (an ask going out, or she is working, waiting or
 * failed) the newest ask's thread gets an empty reply of hers when it has none yet after that ask,
 * so her typing has a slot to show in.
 */
export function astraThreads(turns: readonly AstraTurn[], pending = false): AstraThread[] {
  const threads: AstraThread[] = []
  let current: AstraThread | null = null
  const time = (t: AstraTurn) => (t.at === undefined ? {} : { at: t.at })
  for (const t of turns) {
    if (t.role === 'user') {
      const m = REPLY.exec(t.text)
      const turn = m ? { ...t, text: t.text.slice(m[0].length) } : t
      if (m && threads.length > 0) {
        const named = threads.findLast((x) => threadSnippet(x.root.text) === m[1])
        current = named ?? threads.at(-1)!
        current.replies.push({ kind: 'ask', id: t.id, ...time(t), turn })
        continue
      }
      current = { id: t.id, ...time(t), root: turn, replies: [] }
      threads.push(current)
      continue
    }
    if (!current) {
      current = {
        id: `${t.id}-root`,
        root: { id: `${t.id}-root`, role: 'user', text: '', streaming: false },
        replies: [],
      }
      threads.push(current)
    }
    const last = current.replies.at(-1)
    if (last?.kind === 'reply') {
      last.turns.push(t)
      if (last.at === undefined && t.at !== undefined) last.at = t.at
    } else current.replies.push({ kind: 'reply', id: t.id, ...time(t), turns: [t] })
  }
  if (current) current.newest = true
  if (pending && current && current.replies.at(-1)?.kind !== 'reply') {
    const before = current.replies.at(-1)
    const id = before ? before.id : current.id
    const at = before ? before.at : current.at
    current.replies.push({
      kind: 'reply',
      id: `${id}-pending`,
      ...(at === undefined ? {} : { at }),
      turns: [],
    })
  }
  return threads
}

/**
 * The item's comments and Astra's threads in one timeline, oldest first by time (a thread by its
 * root). A comment comes before a thread at the same moment; threads without a time follow
 * everything, in session order.
 */
export function mergeTimeline<C>(
  comments: readonly C[],
  timeOf: (c: C) => number,
  threads: readonly AstraThread[],
): Array<TimelineEntry<C>> {
  const rows = [
    ...comments.map((c) => ({
      at: timeOf(c),
      rank: 0,
      entry: { kind: 'comment', item: c } as const,
    })),
    ...threads.map((t) => ({
      at: t.at ?? Infinity,
      rank: 1,
      entry: { kind: 'astra', thread: t } as const,
    })),
  ]
  // Array sort is stable: equal rows keep their own order.
  rows.sort((a, b) => a.at - b.at || a.rank - b.rank)
  return rows.map((r) => r.entry)
}

/**
 * Whether Astra's slot shows her typing dots: her newest reply while she is busy and no answer of
 * hers is streaming text into it (nothing yet, or she is between tools).
 */
export function showsTyping(block: AstraBlock, busy: boolean): boolean {
  if (block.kind !== 'reply' || !busy) return false
  const t = block.turns.at(-1)
  return !(t && t.role === 'assistant' && t.streaming && t.text.trim() !== '')
}
