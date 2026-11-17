import { z } from 'zod'

// Trial mode for taste agents, as the renderer sees it. Hand-ported from @relay/protocol trials.ts
// (zod 3 there, zod 4 here): the host folds the atomic-agents journal into cards (one request on
// three models, A / B / C, no model names before Isaac's pick) and switch messages (the agent
// switched its model on his picks, with an Undo). Main keeps the host's latest `trials.snapshot`.

export const TrialLetterSchema = z.enum(['A', 'B', 'C'])
export type TrialLetterValue = z.infer<typeof TrialLetterSchema>

/** A letter, or "can't tell" (`unsure`). */
export const TrialPickSchema = z.union([TrialLetterSchema, z.literal('unsure')])
export type TrialPickValue = z.infer<typeof TrialPickSchema>

export const TrialArmSchema = z.object({
  letter: TrialLetterSchema,
  status: z.enum(['running', 'done', 'failed']),
  /** The result as Markdown (an image is `![](<path or url>)`), once done. */
  preview: z.string().max(20_000).optional(),
  error: z.string().max(1000).optional(),
  seconds: z.number().optional(),
  /** Only after the pick: the model id and its short name. */
  model: z.string().max(200).optional(),
  modelLabel: z.string().max(200).optional(),
})

export const TrialCardSchema = z.object({
  id: z.string().min(1).max(200),
  agent: z.string().min(1).max(200),
  label: z.string().max(200),
  /** The chat it belongs to (`assistant:<id>` or `session:<id>`). */
  thread: z.string().max(400).optional(),
  /** When the request came in (ms): where the card sits in the chat. */
  at: z.number(),
  request: z.string().max(500).optional(),
  arms: z.array(TrialArmSchema).min(2).max(3),
  pick: TrialPickSchema.optional(),
  pickedAt: z.number().optional(),
})
export type TrialCardView = z.infer<typeof TrialCardSchema>

export const TrialSwitchSchema = z.object({
  id: z.string().min(1).max(200),
  agent: z.string().min(1).max(200),
  label: z.string().max(200),
  thread: z.string().max(400).optional(),
  at: z.number(),
  text: z.string().max(1000),
  from: z.string().max(200),
  to: z.string().max(200),
  fromLabel: z.string().max(200),
  toLabel: z.string().max(200),
  kept: z.boolean(),
  undone: z.boolean(),
})
export type TrialSwitchView = z.infer<typeof TrialSwitchSchema>

/** Every card and switch message the host last sent (all chats), and whether it takes picks now. */
export const TrialsViewSchema = z.object({
  /** Connected to a host with the "trials" feature, so a pick or an undo can go out. */
  up: z.boolean(),
  trials: z.array(TrialCardSchema).max(300),
  switches: z.array(TrialSwitchSchema).max(100),
})
export type TrialsView = z.infer<typeof TrialsViewSchema>

/** The host's answer to a pick or an undo: recorded, or why not. */
export const TrialAnswerSchema = z.object({
  ok: z.boolean(),
  error: z.string().max(2000).optional(),
})
export type TrialAnswer = z.infer<typeof TrialAnswerSchema>

export const trialsInvoke = {
  /** The host's cards and switch messages now. */
  'trials.get': {
    input: z.object({}).strict(),
    output: TrialsViewSchema,
  },
  /** Isaac's pick on card `trial` (`trial.pick`, surface desktop); resolves with the host's `trial.picked`. */
  'trials.pick': {
    input: z.object({ trial: z.string().min(1).max(200), pick: TrialPickSchema }).strict(),
    output: TrialAnswerSchema,
  },
  /** Undoes switch `switch` (`trial.undo`); resolves with the host's `trial.undone`. */
  'trials.undo': {
    input: z.object({ switch: z.string().min(1).max(200) }).strict(),
    output: TrialAnswerSchema,
  },
} as const

export const trialsEvents = {
  /** A new snapshot from the host, or the host with the feature came up or went down. */
  'trials.changed': TrialsViewSchema,
} as const
