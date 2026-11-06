import { z } from 'zod'

/**
 * A question waiting on Isaac in an assistant's thread, as the host keeps it (`OpenAsk` in the
 * relay protocol, `assistants/<id>.asks.json`): an assistant reply that ended on `[[replies: ...]]`
 * ("replies"), an omp ask card ("ask"), or a question another session put to him through the
 * thread ("session", whose answer only goes to the host).
 */
export const OpenAskSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{8}$/),
  source: z.enum(['replies', 'ask', 'session']),
  /** The short badge text (the reply's `[[ask-label: ...]]`, else the question cut down). */
  label: z.string(),
  question: z.string(),
  /** The answers a tap sends; empty when none fit. */
  replies: z.array(z.string()),
  /** When it was asked (epoch ms). */
  at: z.number(),
  /** The thread row that asked it, absent once it has left the thread (and for an ask card or session ask). */
  messageId: z.string().optional(),
  /** "session": who asks. */
  from: z.string().optional(),
})
export type OpenAsk = z.infer<typeof OpenAskSchema>

/** An assistant thread's open asks as the host last sent them; null when the host sends none (an older host, or down). */
export const AsksViewSchema = z.object({
  agent: z.string(),
  asks: z.array(OpenAskSchema).nullable(),
})
export type AsksView = z.infer<typeof AsksViewSchema>

export const asksInvoke = {
  /** Follows `agent`'s open asks: asks the host now, again before its follow window ends and after every reconnect, until `asks.unwatch`. */
  'asks.watch': {
    input: z.object({ agent: z.string().min(1).max(128) }).strict(),
    output: AsksViewSchema,
  },
  'asks.unwatch': {
    input: z.object({ agent: z.string().min(1).max(128) }).strict(),
    output: z.object({}),
  },
  /**
   * Closes ask `id` of `agent`'s thread on the host: `answered` (with the answer's words) or
   * `dismissed`. `sent` is false when the host is down; no ack, the next snapshot says.
   */
  'asks.resolve': {
    input: z
      .object({
        agent: z.string().min(1).max(128),
        id: z.string().regex(/^[0-9a-f]{8}$/),
        how: z.enum(['answered', 'dismissed']),
        answer: z.string().trim().min(1).max(500).optional(),
      })
      .strict(),
    output: z.object({ sent: z.boolean() }),
  },
} as const

export const asksEvents = {
  /** A watched thread's open asks after the host's latest snapshot of it. */
  'asks.changed': AsksViewSchema,
} as const
