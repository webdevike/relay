import { z } from 'zod'

// Another assistant popping into an assistant's chat, hand-ported from relay packages/protocol
// (`GuestAgent`, `GuestWork`, `GuestEntry`). The Relay host's consult flow writes one row per step
// into the asking assistant's session file as a `relay-guest` custom message: the guest joined,
// said something, left, or took the question away as work (a card whose state changes arrive as
// new entries with the same `work.id`; `foldGuestWork` keeps one row per piece of work).

/** The custom message type the Relay bridge writes for guest rows. */
export const GUEST_CUSTOM_TYPE = 'relay-guest'

/** The assistant that popped in: its registry id, title and accent (`#rrggbb`) when it has one. */
export const GuestAgentSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(100),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .catch(undefined),
})
export type GuestAgent = z.infer<typeof GuestAgentSchema>

/**
 * Work a guest took on in its own chat. `link` is where the card opens (a place such as
 * `agent:<id>`, the guest's chat when absent).
 */
export const GuestWorkSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().max(400),
  state: z.enum(['working', 'done', 'failed']),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  link: z.string().max(400).optional(),
})
export type GuestWork = z.infer<typeof GuestWorkSchema>

/** One guest row: `text` is what it said (`say`), the result line (`done`) or the reason (`failed`). */
export const GuestEntrySchema = z.object({
  kind: z.enum(['join', 'leave', 'say', 'work']),
  agent: GuestAgentSchema,
  text: z.string().max(20_000).optional(),
  work: GuestWorkSchema.optional(),
})
export type GuestEntry = z.infer<typeof GuestEntrySchema>

/** A `relay-guest` custom message's entry, or null when it is another type or does not parse. */
export function guestEntryOf(customType: unknown, details: unknown): GuestEntry | null {
  if (customType !== GUEST_CUSTOM_TYPE) return null
  const r = GuestEntrySchema.safeParse(details)
  if (!r.success) return null
  // A work row without its work says nothing a card could show.
  return r.data.kind === 'work' && r.data.work === undefined ? null : r.data
}

/** Where a work card opens: its own link, else the guest's chat. */
export function workLink(entry: GuestEntry): string {
  return entry.work?.link ?? `agent:${entry.agent.id}`
}

/**
 * `list` with each piece of work as one row: the latest state of a `work.id`, at the place (and
 * under the id) of its first row, so a card that finishes changes in place instead of moving.
 */
export function foldGuestWork<T extends { id: string; guest?: GuestEntry | undefined }>(
  list: readonly T[],
): T[] {
  const latest = new Map<string, T>()
  for (const m of list) {
    const id = m.guest?.work?.id
    if (m.guest?.kind === 'work' && id !== undefined) latest.set(id, m)
  }
  if (latest.size === 0) return list as T[]
  const placed = new Set<string>()
  const out: T[] = []
  for (const m of list) {
    const id = m.guest?.kind === 'work' ? m.guest.work?.id : undefined
    if (id === undefined) {
      out.push(m)
      continue
    }
    if (placed.has(id)) continue
    placed.add(id)
    const last = latest.get(id)!
    out.push(last === m ? m : { ...last, id: m.id })
  }
  return out
}

/**
 * The guest typing at the end of `list`: one that joined in the current turn (since the last user
 * row) and has neither spoken nor left since. Null when no guest is in the middle of answering.
 */
export function guestTyping(
  list: readonly { role: string; guest?: GuestEntry | undefined }[],
): GuestAgent | null {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i]!
    if (m.role === 'user') return null
    const g = m.guest
    if (g === undefined || g.kind === 'work') continue
    return g.kind === 'join' ? g.agent : null
  }
  return null
}
