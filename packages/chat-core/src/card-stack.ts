/**
 * The card stack on the composer (Relay desktop and the phone): which card is in front as cards come
 * and go, stepping through them, and how a running card reads (its clock, model and recent work).
 * Pure; each app's `card-stack.machine.ts` keeps the stack's state with these.
 */

/**
 * The card in front after the stack changed from `before` to `after`: the same one while it is still
 * there, else the first card after it that stayed, else the last card; the first card when none was
 * in front, and null when the stack is empty.
 */
export function settleFront(
  before: readonly string[],
  after: readonly string[],
  front: string | null,
): string | null {
  if (front === null) return after[0] ?? null
  if (after.includes(front)) return front
  const kept = before.slice(before.indexOf(front) + 1).find((id) => after.includes(id))
  return kept ?? after[after.length - 1] ?? null
}

/** The card `by` steps away from `front`: past either end it wraps when `loop`, else it stops there. */
export function stepFront(
  ids: readonly string[],
  front: string | null,
  by: number,
  loop: boolean,
): string | null {
  if (ids.length === 0) return null
  const at = Math.max(0, ids.indexOf(front ?? ''))
  const next = loop
    ? (((at + by) % ids.length) + ids.length) % ids.length
    : Math.min(ids.length - 1, Math.max(0, at + by))
  return ids[next] ?? null
}

/** How long a run has gone: "35m 12s" under an hour, "1h 04m" from then on. */
export function runClock(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const seconds = Math.max(0, Math.floor(ms / 1000)) % 60
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
    : `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

export type CardVendor = 'anthropic' | 'openai'

/**
 * Whose logo a running card shows: the vendor the source names, else the one the model's name
 * gives away; null when neither says (the card then shows the name alone).
 */
export function cardVendor(model?: string, vendor?: string): CardVendor | null {
  const named = vendor?.toLowerCase() ?? ''
  if (named.startsWith('anthropic')) return 'anthropic'
  if (named.startsWith('openai')) return 'openai'
  if (model === undefined) return null
  if (/claude|opus|sonnet|haiku|fable/i.test(model)) return 'anthropic'
  if (/gpt|codex|(^|\/)o\d/i.test(model)) return 'openai'
  return null
}

/**
 * The model as a running card names it beside the logo: no provider path or "Claude" brand word,
 * the thinking level after it ("Opus 5.5 high"); null when the source names no model.
 */
export function cardModel(model?: string, thinking?: string): string | null {
  if (model === undefined || model.trim() === '') return null
  const name = model
    .slice(model.lastIndexOf('/') + 1)
    .replace(/^claude[\s-]+/i, '')
    .trim()
  return thinking === undefined || thinking === '' || thinking === 'off'
    ? name
    : `${name} ${thinking}`
}

/** A running card's recent work, oldest first: the host's log, else the latest line alone (an older host). */
export function recentWork(run: { log?: readonly string[]; intent: string }): string[] {
  if (run.log !== undefined && run.log.length > 0) return run.log.slice(-4)
  return run.intent === '' ? [] : [run.intent]
}
