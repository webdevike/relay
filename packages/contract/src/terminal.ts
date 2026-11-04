import { z } from 'zod'

// Terminal tool: shells (and a chat's herdr session) in a pty that main owns, shown by xterm.js in
// the renderer. The renderer names a chat's session file, never a path or a command: main decides
// the folder (the chat's worktree, else its cwd, else the Eva root) and what runs.

const Id = z.string().min(1).max(64)
const Cols = z.number().int().min(1).max(1000)
const Rows = z.number().int().min(1).max(1000)
const ChatFile = z.string().min(1).max(4096).startsWith('/').nullable()

export const TerminalModeSchema = z.enum(['shell', 'attach'])
export type TerminalMode = z.infer<typeof TerminalModeSchema>

export const terminalInvoke = {
  /** Starts a pty: the user's login shell in the chat's folder, or `herdr agent attach` to the chat's session. */
  'terminal.spawn': {
    input: z.object({ file: ChatFile, mode: TerminalModeSchema, cols: Cols, rows: Rows }).strict(),
    output: z.object({ id: Id, cwd: z.string(), title: z.string() }).strict(),
  },
  'terminal.write': {
    input: z.object({ id: Id, data: z.string().max(1_000_000) }).strict(),
    output: z.object({}).strict(),
  },
  'terminal.resize': {
    input: z.object({ id: Id, cols: Cols, rows: Rows }).strict(),
    output: z.object({}).strict(),
  },
  /** Ends the pty; a pty that already exited is not an error. */
  'terminal.kill': {
    input: z.object({ id: Id }).strict(),
    output: z.object({}).strict(),
  },
  /** The herdr pane running the chat's session, or null (no herdr, or the chat is not in herdr). */
  'terminal.attachable': {
    input: z.object({ file: ChatFile }).strict(),
    output: z.object({ pane: z.string().nullable() }).strict(),
  },
} as const

export const terminalEvents = {
  /** Output of one pty, coalesced per few milliseconds. */
  'terminal.data': z.object({ id: Id, data: z.string() }).strict(),
  'terminal.exit': z.object({ id: Id, code: z.number().nullable() }).strict(),
} as const
