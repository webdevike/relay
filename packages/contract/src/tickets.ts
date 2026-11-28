import { z } from 'zod'

// Synced Linear tickets from the Relay Host (relay packages/protocol/src/tickets.ts). The contract
// package can't import @relay/protocol, so the host's shapes pass through loosely here: main
// validates every host frame against the protocol schemas, and the renderer reads them with the
// protocol's types (TicketsBoard, TicketsStatus, TicketDetail, TicketApproval, TicketOutcome ...).

const TicketKey = z
  .string()
  .regex(/^[A-Z][A-Z0-9]*-\d+$/)
  .max(40)

/** Why the board isn't the host's: no host, a host without tickets, sync off, or not connected. */
export const TicketsFallbackReasonSchema = z.enum(['noHost', 'oldHost', 'off', 'disconnected'])
export type TicketsFallbackReason = z.infer<typeof TicketsFallbackReasonSchema>

export const TicketsFallbackSchema = z.object({
  source: z.literal('fallback'),
  reason: TicketsFallbackReasonSchema,
  /** One line for the toolbar. */
  message: z.string(),
})
export type TicketsFallback = z.infer<typeof TicketsFallbackSchema>

/** protocol TicketsBoard. */
const BoardSchema = z.looseObject({ tickets: z.array(z.looseObject({ key: z.string() })) })
/** protocol TicketsStatus. */
const StatusSchema = z.looseObject({})
/** The gate said no; nothing was written (protocol TicketsRefusalCode). */
const RefusedSchema = z.object({ code: z.string(), message: z.string() })

/** protocol TicketMutation; main checks it against the protocol schema before it goes out. */
export const TicketMutationInputSchema = z.looseObject({
  kind: z.enum([
    'setState',
    'comment',
    'editComment',
    'deleteComment',
    'resolve',
    'react',
    'subscribe',
    'createIssue',
    'applyPlan',
  ]),
})
/** protocol HandledTarget. */
const HandledTargetSchema = z.looseObject({ kind: z.enum(['mention', 'needs']) })

function fromHost<T extends z.ZodRawShape>(shape: T) {
  return z.discriminatedUnion('source', [
    z.object({ source: z.literal('host'), ...shape }),
    TicketsFallbackSchema,
  ])
}

export const TicketsBoardAnswerSchema = fromHost({
  rev: z.number(),
  board: BoardSchema,
  status: StatusSchema,
})
export type TicketsBoardAnswer = z.infer<typeof TicketsBoardAnswerSchema>

export const ticketsInvoke = {
  /** The host's synced board (kept current by pushes), or why there is none. */
  'tickets.board': { input: z.object({}).strict(), output: TicketsBoardAnswerSchema },
  /** One ticket's page (protocol TicketDetail). */
  'tickets.ticket': {
    input: z.object({ key: TicketKey }).strict(),
    output: fromHost({ ticket: z.looseObject({ key: z.string() }) }),
  },
  /** Keeps these keys synced although they aren't Isaac's (agent cards). */
  'tickets.watch': {
    input: z.object({ keys: z.array(TicketKey).max(50) }).strict(),
    output: fromHost({}),
  },
  /** Sync now (coalesced on the host). */
  'tickets.sync': { input: z.object({}).strict(), output: fromHost({}) },
  /** Isaac opened the ticket: the watermark from before this visit. */
  'tickets.seen': {
    input: z.object({ key: TicketKey }).strict(),
    output: fromHost({ previousSeenAt: z.number().nullable() }),
  },
  /** Mark as handled (Relay-only), or bring it back. */
  'tickets.handled': {
    input: z.object({ target: HandledTargetSchema, undo: z.boolean() }).strict(),
    output: fromHost({}),
  },
  /**
   * A confirmed write's approval (protocol TicketApproval), or the gate's refusal. `viewerId`: the
   * Linear account the page showed (`tickets.status` identity); the host refuses another.
   */
  'tickets.prepare': {
    input: z
      .object({ viewerId: z.string().min(1).max(200), mutation: TicketMutationInputSchema })
      .strict(),
    output: fromHost({ approval: z.looseObject({}).optional(), refused: RefusedSchema.optional() }),
  },
  /** The write (protocol TicketOutcome), or the gate's refusal; retries reuse `opId` and `viewerId`. */
  'tickets.commit': {
    input: z
      .object({
        viewerId: z.string().min(1).max(200),
        approvalId: z.string().min(1).max(200).optional(),
        opId: z.string().uuid(),
        mutation: TicketMutationInputSchema,
      })
      .strict(),
    output: fromHost({ outcome: z.looseObject({}).optional(), refused: RefusedSchema.optional() }),
  },
  /** The 2-3 sentence summary (protocol TicketSummary). */
  'tickets.summary': {
    input: z.object({ key: TicketKey }).strict(),
    output: fromHost({ summary: z.looseObject({}) }),
  },
  /** Relay-only Timeline starts (host `plan.json`, never Linear); null clears one. */
  'tickets.plan': {
    input: z
      .object({
        rows: z
          .array(
            z
              .object({
                key: TicketKey,
                plannedStart: z
                  .string()
                  .regex(/^\d{4}-\d{2}-\d{2}$/)
                  .nullable(),
              })
              .strict(),
          )
          .min(1)
          .max(200),
      })
      .strict(),
    output: fromHost({}),
  },
  /**
   * Ask Astra (private, read-only, never posted) to re-plan a project or one milestone: her
   * validated proposal (protocol TicketPlanProposal), or `refused` when it isn't a readable plan.
   */
  'tickets.replan': {
    input: z
      .object({
        projectId: z.string().min(1).max(200),
        milestoneId: z.string().min(1).max(200).optional(),
      })
      .strict(),
    output: fromHost({ proposal: z.looseObject({}).optional(), refused: RefusedSchema.optional() }),
  },
} as const

export const ticketsEvents = {
  /** Tickets changed on the host: these keys (null: the whole board), and the sync status when it moved. */
  'tickets.changed': z.object({
    keys: z.array(z.string()).nullable(),
    status: StatusSchema.optional(),
  }),
} as const
