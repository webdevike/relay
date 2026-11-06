import { z } from 'zod'

/**
 * The Skills page: every omp skill the assistants load, read and edited through the Relay host's
 * loopback routes (`/skills/...`). Shapes hand-ported from proof/skills-page/CONTRACT.md.
 */

/**
 * A skill's name as omp lists it: bare (`canvas`), `:` for plugin-namespaced ones, or omp's
 * `<source>/<name>` for a copy whose name another source took (`agents/hallmark`).
 */
export const SkillNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._:-]{0,79}(?:\/[a-z0-9][a-z0-9._:-]{0,79})?$/)

export const SkillSourceSchema = z.object({
  /** omp's source id: `native:project`, `native:user`, `agents:user`, `claude:project`, a plugin's... */
  key: z.string().max(100),
  /** `Project`, `User`, `Agents`, `Claude project`, ... */
  label: z.string().max(200),
  /** The folder for display, `~` for home. */
  dir: z.string().max(4096),
  /** The absolute SKILL.md path. */
  file: z.string().max(4096),
})
export type SkillSource = z.infer<typeof SkillSourceSchema>

export const SkillAssistantSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().max(200),
  profile: z.string().max(200).nullable(),
  /** The assistant's accent color. */
  color: z.string().max(64),
})
export type SkillAssistant = z.infer<typeof SkillAssistantSchema>

export const SkillRowSchema = z.object({
  name: SkillNameSchema,
  description: z.string().max(4000),
  /** The copy omp lists (the assistants' profiles first). */
  source: SkillSourceSchema,
  /** Other copies of the same name. */
  also: z.array(SkillSourceSchema).max(20),
  /** Newest mtime in the skill folder, ms. */
  updatedAt: z.number(),
  /** Assistant ids that load it. */
  usedBy: z.array(z.string().max(100)).max(100),
  /** The SKILL.md frontmatter says `enabled: false`. */
  disabled: z.boolean(),
  /** The newest load, ms; null when never. */
  lastUsedAt: z.number().nullable(),
  /** Loads ever; null while the host's first usage scan runs, absent from hosts before usage stats. */
  uses: z.number().int().nullable().optional(),
})
export type SkillRow = z.infer<typeof SkillRowSchema>

/** Loads of one skill by one agent. */
export const SkillAgentUsesSchema = z.object({
  /** An assistant id, omp agent (`scout`; `session` for the default), job name, `eren`, `elysia`, `claude-code` or `other`. */
  agent: z.string().max(100),
  kind: z.enum(['assistant', 'session', 'subagent', 'job', 'background', 'claude', 'other']),
  /** The assistant it worked for; null when none or unknown. */
  owner: z.string().max(100).nullable(),
  uses: z.number().int(),
  lastUsedAt: z.number(),
})
export type SkillAgentUses = z.infer<typeof SkillAgentUsesSchema>

export const SkillStatsSchema = z.object({
  uses: z.number().int(),
  uses7d: z.number().int(),
  uses30d: z.number().int(),
  lastUsedAt: z.number().nullable(),
  firstUsedAt: z.number().nullable(),
  /** Most uses first. */
  byAgent: z.array(SkillAgentUsesSchema).max(500),
  /** Loads per local day for the last 30 days, oldest first, today last. */
  daily: z.array(z.number().int()).max(31),
})
export type SkillStats = z.infer<typeof SkillStatsSchema>

export const SkillDetailSchema = SkillRowSchema.extend({
  files: z.array(z.object({ path: z.string().max(4096), size: z.number() })).max(2000),
  /** Null while the host's first usage scan runs; absent from hosts before usage stats. */
  stats: SkillStatsSchema.nullable().optional(),
  /** The profile each assistant runs, so toggles that are shared can say so. */
  profiles: z.record(z.string(), z.string().nullable()),
})
export type SkillDetail = z.infer<typeof SkillDetailSchema>

export const SkillListSchema = z.object({
  skills: z.array(SkillRowSchema).max(2000),
  assistants: z.array(SkillAssistantSchema).max(100),
  /** False without a Relay host on this Mac; `error` says why. */
  available: z.boolean(),
  error: z.string().max(500).optional(),
})
export type SkillList = z.infer<typeof SkillListSchema>

export const SkillUserSchema = z.object({
  name: z.string().min(1).max(100),
  color: z.string().max(64),
  kind: z.enum(['human', 'agent']),
})
export type SkillUser = z.infer<typeof SkillUserSchema>

export const SkillOpenSchema = z.object({
  /** `ws://127.0.0.1:<port>/skills/<name>`; the provider appends the room. */
  serverUrl: z.string().startsWith('ws://127.0.0.1:'),
  room: z.literal('ws'),
  token: z.string().min(1).max(400),
  user: SkillUserSchema,
})
export type SkillOpen = z.infer<typeof SkillOpenSchema>

const Named = z.object({ name: SkillNameSchema }).strict()

export const skillsInvoke = {
  /** Every skill and assistant; `available: false` (with the reason) without a local host. */
  'skills.list': { input: z.object({}).strict(), output: SkillListSchema },
  'skills.detail': { input: Named, output: SkillDetailSchema },
  /** Turns the skill on or off per assistant (assistants sharing a profile move together). */
  'skills.access': {
    input: z
      .object({ name: SkillNameSchema, enabled: z.record(z.string().max(100), z.boolean()) })
      .strict(),
    output: SkillRowSchema,
  },
  /** A way into the skill's live document for this app's editor. */
  'skills.open': { input: Named, output: SkillOpenSchema },
  /** Writes the live document to SKILL.md; `changed-on-disk` unless `force` when it moved under us. */
  'skills.save': {
    input: z.object({ name: SkillNameSchema, force: z.boolean().optional() }).strict(),
    output: z.object({ status: z.enum(['saved', 'changed-on-disk']) }),
  },
  /** Replaces the live document with SKILL.md as it is on disk. */
  'skills.reload': { input: Named, output: z.object({ reloaded: z.literal(true) }) },
} as const
