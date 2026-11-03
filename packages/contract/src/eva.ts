import { z } from 'zod'

export const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const WsId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/)
  .max(100)
export const JobName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .max(64)
export const Stem = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .max(200)
export const Text = (n: number) => z.string().max(n)

// The reader keeps the Rust rule: any `T...` token. Strictness lives in the accept output only.
const TodoId = z
  .string()
  .regex(/^T\S*$/)
  .max(100)

export const WorkspaceSummarySchema = z.object({
  id: z.string().max(100),
  name: z.string().max(200),
  displayName: z.string().max(200),
  tagline: z.string().max(2000).nullable(),
  latest: z.string().max(2000).nullable(),
  lastActive: Day.nullable(),
  openTodos: z.number().int().min(0),
  builtIn: z.boolean(),
  hasFile: z.boolean(),
  aliases: z.array(z.string().max(100)).max(20),
  daily: z.array(z.number().int().min(0)).length(90),
})

export const OpenTodoSchema = z.object({
  id: TodoId,
  tag: z.string().max(100),
  text: z.string().max(10000),
  added: Day.nullable(),
})

export const DashboardSchema = z.object({
  today: Day,
  generatedAt: z.number().int(),
  workspaces: z.array(WorkspaceSummarySchema).max(500),
  todos: z.array(OpenTodoSchema).max(2000),
  updates7d: z.number().int().min(0),
})

export const WorkspaceDetailSchema = z.object({
  today: Day,
  workspace: WorkspaceSummarySchema.nullable(),
  timeline: z
    .array(
      z.object({
        date: Day,
        kind: z.enum(['journal', 'thread']),
        title: z.string().max(2000),
        source: z.string().max(300),
      }),
    )
    .max(5000),
  todos: z.array(OpenTodoSchema).max(2000),
  sections: z
    .array(z.object({ title: z.string().max(500), body: z.string().max(200000) }))
    .max(200),
})

export type WorkspaceSummary = z.output<typeof WorkspaceSummarySchema>
export type OpenTodoDto = z.output<typeof OpenTodoSchema>
export type DashboardPayload = z.output<typeof DashboardSchema>
export type WorkspaceDetail = z.output<typeof WorkspaceDetailSchema>

export const evaInvoke = {
  'eva.sidebar': {
    input: z.object({}).strict(),
    output: z.object({
      openTodos: z.number().int().min(0),
      scheduledJobs: z.number().int().min(0),
    }),
  },
  'eva.dashboard': {
    input: z.object({}).strict(),
    output: DashboardSchema,
  },
  'eva.workspace': {
    input: z.object({ id: WsId }).strict(),
    output: WorkspaceDetailSchema,
  },
  'eva.workspace.openFile': {
    input: z.object({ id: WsId }).strict(),
    output: z.object({ opened: z.literal(true) }),
  },
  'eva.todo.preview': {
    input: z.object({}).strict(),
    output: z.object({ nextId: TodoId, today: Day }),
  },
  'eva.todo.add': {
    input: z.object({ tag: WsId, text: z.string().min(1).max(2000) }).strict(),
    output: z.object({ id: TodoId, tag: z.string().max(100), row: z.string().max(2100) }),
  },
} as const

export const evaEvents = {
  'eva.changed': z.object({
    areas: z.array(z.enum(['workspaces', 'memory', 'jobs', 'meetings'])).max(4),
  }),
} as const
