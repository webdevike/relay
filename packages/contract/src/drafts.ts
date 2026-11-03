import { z } from 'zod'

/** Main keeps the newest this many composer drafts; older ones are dropped. */
export const MAX_COMPOSER_DRAFTS = 100

/**
 * A chat's composer draft key: its session file, or the draft app tab's scope (`draft:<tab id>`)
 * while the chat has no file yet.
 */
const DraftKeySchema = z.string().min(1).max(4096)

export const ComposerDraftSchema = z.object({
  key: DraftKeySchema,
  text: z.string().min(1).max(1_000_000),
})
export type ComposerDraft = z.infer<typeof ComposerDraftSchema>

export const draftsInvoke = {
  /** The saved drafts, newest first. */
  'drafts.load': {
    input: z.object({}).strict(),
    output: z.object({ drafts: z.array(ComposerDraftSchema).max(MAX_COMPOSER_DRAFTS) }),
  },
  /** Replaces one chat's draft; empty text forgets it (the message was sent or deleted). */
  'drafts.save': {
    input: z.object({ key: DraftKeySchema, text: z.string().max(1_000_000) }).strict(),
    output: z.object({}),
  },
} as const
