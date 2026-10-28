import { z } from 'zod'
import { JobName } from './eva'
import { ExperimentIdSchema } from './experiments'

// The context popover: the header button left of the panel toggle and the popover it opens. Main
// reads everything (ledgers, git, gh, session folders, jobs, Test Bench) and sends one snapshot;
// the renderer only draws it. Pins are the only state it writes (in the app's config dir).

const AbsPath = z.string().min(2).max(4096).startsWith('/')
const SessionFile = AbsPath.endsWith('.jsonl')
/** `owner/repo` on GitHub. */
export const RepoSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
/** A ledger's file stem under work/items (`ENG-6524`, `relay-rooms`). */
export const ItemKeySchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)

/** What a pin points at; main resolves it to a fresh row on every snapshot. */
export const PinRefSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('pr'), repo: RepoSchema, number: z.number().int().positive() })
    .strict(),
  z.object({ kind: z.literal('item'), key: ItemKeySchema }).strict(),
  z.object({ kind: z.literal('experiment'), id: ExperimentIdSchema }).strict(),
  z.object({ kind: z.literal('job'), name: JobName }).strict(),
  /** A chat or subagent transcript; `title` is what the row showed when pinned. */
  z
    .object({ kind: z.literal('session'), file: SessionFile, title: z.string().min(1).max(200) })
    .strict(),
])
export type PinRef = z.infer<typeof PinRefSchema>

/** One stable id per pinned thing, so pinning twice keeps one pin. */
export function pinId(ref: PinRef): string {
  switch (ref.kind) {
    case 'pr':
      return `pr:${ref.repo}#${ref.number}`
    case 'item':
      return `item:${ref.key}`
    case 'experiment':
      return `experiment:${ref.id}`
    case 'job':
      return `job:${ref.name}`
    case 'session':
      return `session:${ref.file}`
  }
}
export const PinIdSchema = z.string().min(1).max(4200)

/** What clicking a row does. */
export const ContextOpenSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url'), url: z.string().url().max(2048) }),
  z.object({ kind: z.literal('files'), path: AbsPath }),
  z.object({ kind: z.literal('chat'), file: SessionFile }),
  z.object({
    kind: z.literal('subagent'),
    session: SessionFile,
    file: SessionFile,
    name: z.string(),
  }),
  z.object({ kind: z.literal('experiment'), id: ExperimentIdSchema }),
  z.object({ kind: z.literal('jobs') }),
])
export type ContextOpen = z.infer<typeof ContextOpenSchema>

export const CONTEXT_ICONS = [
  'pr',
  'branch',
  'checks',
  'checks-failed',
  'checks-pending',
  'review',
  'diff',
  'stage',
  'running',
  'needs',
  'done',
  'failed',
  'experiment',
  'job',
  'item',
  'chat',
  /** Built work waiting for Isaac to look at it (Ready for review). */
  'ready',
] as const
export const ContextToneSchema = z.enum(['default', 'success', 'danger', 'warning', 'info'])
export type ContextTone = z.infer<typeof ContextToneSchema>

export const ContextRowSchema = z.object({
  /** Unique within the snapshot. */
  id: z.string(),
  icon: z.enum(CONTEXT_ICONS),
  tone: ContextToneSchema,
  title: z.string(),
  /** Monospace title (branches). */
  mono: z.boolean(),
  /** A dimmer second line, or null. */
  sub: z.string().nullable(),
  /** Right-hand text: "2 of 2 passed", "develop", "Day 5". */
  meta: z.string().nullable(),
  /**
   * Right-hand time: elapsed ("6m") while running or waiting, a clock time ("4:29 PM") when done,
   * a day ("Today", "Oct 26") for a ledger's `updated:` date.
   */
  time: z.object({ at: z.number(), style: z.enum(['elapsed', 'clock', 'day']) }).nullable(),
  pill: z.object({ label: z.string(), tone: ContextToneSchema }).nullable(),
  diff: z
    .object({ add: z.number().int().nonnegative(), del: z.number().int().nonnegative() })
    .nullable(),
  progress: z
    .object({ done: z.number().int().nonnegative(), total: z.number().int().positive() })
    .nullable(),
  /** Set when the row can be pinned (or, in Pinned, unpinned). */
  pin: PinRefSchema.nullable(),
  open: ContextOpenSchema.nullable(),
})
export type ContextRow = z.infer<typeof ContextRowSchema>

export const ContextSectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  meta: z.string().nullable(),
  /** Starts folded: only its heading shows, and pressing it shows the rows (Resolved). */
  fold: z.boolean(),
  rows: z.array(ContextRowSchema),
})
export type ContextSection = z.infer<typeof ContextSectionSchema>

/** Code-chat buttons. Commit & push only appears when it is safe, and only fills the composer. */
export const ContextActionSchema = z.discriminatedUnion('id', [
  z.object({ id: z.literal('open-pr'), url: z.string().url().max(2048) }),
  z.object({ id: z.literal('open-files'), path: AbsPath }),
  z.object({ id: z.literal('commit-push'), prompt: z.string().min(1).max(2000) }),
])
export type ContextAction = z.infer<typeof ContextActionSchema>

export const ContextScopeSchema = z.enum(['here', 'everywhere'])
export type ContextScope = z.infer<typeof ContextScopeSchema>

export const ContextSnapshotSchema = z.object({
  /** What "here" is: a code chat, an assistant's thread, or nothing (other pages). */
  kind: z.enum(['code', 'chat', 'assistant', 'none']),
  /** The button: its icon, short label and state dot (needs you > failing > running). */
  button: z.object({
    icon: z.enum(['pr', 'branch', 'activity']),
    label: z.string().nullable(),
    dot: z.enum(['needs', 'failing', 'running']).nullable(),
    /** Tooltip and aria text. */
    summary: z.string(),
  }),
  scope: ContextScopeSchema,
  pinned: z.array(ContextRowSchema),
  sections: z.array(ContextSectionSchema),
  actions: z.array(ContextActionSchema),
  footer: z.object({
    jobsRunning: z.number().int().nonnegative(),
    jobsScheduled: z.number().int().nonnegative(),
    benchRunning: z.number().int().nonnegative(),
  }),
  updatedAt: z.number(),
})
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>

export const ContextQuerySchema = z
  .object({
    /** The open chat's (or assistant thread's) session file. */
    file: SessionFile.nullable(),
    /** The registry id on an assistant's page. */
    agent: z
      .string()
      .max(128)
      .regex(/^[a-z0-9][a-z0-9_-]*$/)
      .nullable(),
    scope: ContextScopeSchema,
    /** The popover is open: refresh PR facts sooner. */
    open: z.boolean(),
  })
  .strict()
export type ContextQuery = z.infer<typeof ContextQuerySchema>

export const contextInvoke = {
  'context.get': { input: ContextQuerySchema, output: ContextSnapshotSchema },
  'context.pin': {
    input: z.object({ ref: PinRefSchema }).strict(),
    output: z.object({ pins: z.array(PinRefSchema) }),
  },
  'context.unpin': {
    input: z.object({ id: PinIdSchema }).strict(),
    output: z.object({ pins: z.array(PinRefSchema) }),
  },
} as const

export const contextEvents = {
  /** Something a snapshot shows changed (a gh or git refresh landed, a pin, a session file). */
  'context.changed': z.object({}),
} as const
