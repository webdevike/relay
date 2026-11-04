import { z } from 'zod'
import { RelPathSchema } from './files'

// Live presence in the Files editor, through the Relay Host: the renderer says which text tabs
// are open and where Isaac's caret is; main maps them to paths on the host and back. The host
// says which lines an agent's write changed (and whose it was) and where Isaac's caret is on his
// other devices.

const RootSchema = z.string().min(1).max(4096).startsWith('/')
const PosSchema = z
  .object({ line: z.number().int().positive(), column: z.number().int().positive() })
  .strict()
const TargetSchema = z.object({ root: RootSchema, path: RelPathSchema }).strict()

export const PresenceRangeSchema = z
  .object({ startLine: z.number().int().positive(), endLine: z.number().int().positive() })
  .strict()
export type PresenceRange = z.infer<typeof PresenceRangeSchema>

/** Who wrote an edit: the agent's name, color and portrait (a full URL on the host). */
export const PresenceAgentSchema = z
  .object({
    name: z.string().min(1).max(200),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    avatarUrl: z.string().max(2000).optional(),
  })
  .strict()
export type PresenceAgent = z.infer<typeof PresenceAgentSchema>

const SelectionSchema = z.object({ start: PosSchema, end: PosSchema }).strict()

export const PresenceEditSchema = z
  .object({
    /** The open tabs the edited file is (one file can be open under two roots). */
    targets: z.array(TargetSchema).max(20),
    /** sha1 hex of the file's bytes now. */
    hash: z.string().min(1).max(128),
    ranges: z.array(PresenceRangeSchema).max(50),
    caret: PosSchema,
    agent: PresenceAgentSchema,
    intent: z.string().max(300).optional(),
    at: z.number(),
  })
  .strict()
export type PresenceEdit = z.infer<typeof PresenceEditSchema>

/** Isaac's caret on another device: `path` is absolute on the host. */
export const PresenceFocusSchema = z
  .object({
    device: z.string().min(1).max(200),
    deviceName: z.string().max(200),
    path: z.string().min(1).max(4096),
    caret: PosSchema,
    selection: SelectionSchema.optional(),
    selectedText: z.string().max(2000).optional(),
    at: z.number(),
  })
  .strict()
export type PresenceFocus = z.infer<typeof PresenceFocusSchema>

export const filesPresenceInvoke = {
  /** Every open text tab across the Files workspaces; main tells the host (it watches them for agent edits). */
  'files.presence.open': {
    input: z.object({ files: z.array(TargetSchema).max(200) }).strict(),
    output: z.object({}).strict(),
  },
  /** Where Isaac's caret is in the editor, or nowhere (null). Agents read it through the host. */
  'files.presence.caret': {
    input: z
      .object({
        focus: z
          .object({
            root: RootSchema,
            path: RelPathSchema,
            caret: PosSchema,
            selection: SelectionSchema.optional(),
            selectedText: z.string().max(2000).optional(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    output: z.object({}).strict(),
  },
} as const

export const filesPresenceEvents = {
  /** An agent's write to an open file landed on disk. */
  'files.presence.edit': PresenceEditSchema,
  /** Isaac's caret on his other devices, newest first (the whole list each time). */
  'files.presence.focus': z.object({ focus: z.array(PresenceFocusSchema).max(20) }).strict(),
} as const
