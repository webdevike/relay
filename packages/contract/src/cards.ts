import { z } from 'zod'

/** The dismissed status cards as the renderer sees them, and whether the host keeps them. */
export const DismissedCardsViewSchema = z.object({
  /** Connected to a host that keeps the set (the "cards.dismissed" feature), so a change can be sent. */
  up: z.boolean(),
  /** The host's set, oldest first; null before its first snapshot (or without a host that keeps it). */
  ids: z.array(z.string().max(200)).nullable(),
})
export type DismissedCardsView = z.infer<typeof DismissedCardsViewSchema>

export const cardsInvoke = {
  /** The host's dismissed status cards now. */
  'cards.dismissed.get': {
    input: z.object({}).strict(),
    output: DismissedCardsViewSchema,
  },
  /** Dismisses (`on`) or restores card `id` on the host; `sent` is false when it keeps none or is down. No ack: the next snapshot says. */
  'cards.dismiss': {
    input: z.object({ id: z.string().min(1).max(200), on: z.boolean() }).strict(),
    output: z.object({ sent: z.boolean() }),
  },
} as const

export const cardsEvents = {
  /** The host's set changed (a snapshot), or Relay came up or went down. */
  'cards.dismissed.changed': DismissedCardsViewSchema,
} as const
