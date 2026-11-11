import { z } from 'zod'

// ---------------------------------------------------------------------------------------------
// Chat rooms (Assistants > Rooms): a persisted conversation of several members, each an exact omp
// model with its own thinking level and role. Created idle; nothing runs until Isaac's first
// message. Spec: HANDOFF.md in the relay repo (Rooms inside Assistants) and Eva
// work/rooms-assistants-proto.
// ---------------------------------------------------------------------------------------------

/** omp's thinking levels, lowest first (`off` turns reasoning off). */
export const OMP_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
export const OmpThinkingSchema = z.enum(OMP_THINKING_LEVELS)
export type OmpThinking = z.infer<typeof OmpThinkingSchema>

/** An exact omp model id, `provider/id` (the id may hold slashes: `qwen-local/mlx-community/...`). */
export const OmpModelIdSchema = z
  .string()
  .max(200)
  .regex(/^[a-z0-9][a-z0-9._-]*\/\S+$/, 'a model is an exact omp id, provider/id')

/** A member's stable id inside its room: an assistant's registry id, or a slug of a custom name. */
export const RoomMemberIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)

export const ChatRoomMemberSchema = z
  .object({
    id: RoomMemberIdSchema,
    /** The registry assistant this member is (`.omp/assistant/agents.json`); absent for a custom agent. */
    assistant: z.string().min(1).max(64).optional(),
    name: z.string().trim().min(1).max(40),
    model: OmpModelIdSchema,
    thinking: OmpThinkingSchema,
    /** What the member does in this room ("Argue for", "Reviews diffs"); may be empty. */
    role: z.string().trim().max(80),
    instructions: z.string().trim().max(4000).optional(),
    /** Joined because Isaac @mentioned an assistant who was not in the room. */
    guest: z.boolean().optional(),
  })
  .strict()
export type ChatRoomMember = z.infer<typeof ChatRoomMemberSchema>

export const ROOM_TEMPLATE_KEYS = ['debate', 'council', 'build', 'blank'] as const
export const RoomTemplateSchema = z.enum(ROOM_TEMPLATE_KEYS)
export type RoomTemplate = z.infer<typeof RoomTemplateSchema>

export const ROOM_MAX_MEMBERS = 8
export const ROOM_MAX_REFS = 12
export const ROOM_MAX_BUDGET = 1000

/** The fields of a chat room's setup, each on its own (rooms.update takes any of them). */
export const ChatRoomSetupFieldsSchema = z
  .object({
    /** Absent until Isaac names the room or his first message names it. */
    title: z.string().trim().min(1).max(120).optional(),
    template: RoomTemplateSchema,
    members: z.array(ChatRoomMemberSchema).min(1).max(ROOM_MAX_MEMBERS),
    /** 1..5 (Quick..Max): bounds the turns each of Isaac's messages starts. */
    effort: z.number().int().min(1).max(5),
    /** The hard cap in USD; the room pauses itself before a turn would cross it. */
    budget: z.number().positive().max(ROOM_MAX_BUDGET),
    /** A folder copied into the room's workdir (absolute, or relative to the Eva root). */
    folder: z.string().trim().min(1).max(1000).optional(),
    /** Paths or URLs the members are pointed at. */
    refs: z.array(z.string().trim().min(1).max(1000)).max(ROOM_MAX_REFS),
    /** A suggested first message, shown unsent in the composer; never posted by itself. */
    draft: z.string().max(4000).optional(),
  })
  .strict()

const uniqueMembers = (
  members: readonly ChatRoomMember[] | undefined,
  ctx: z.RefinementCtx,
): void => {
  const seen = new Set<string>()
  for (const [i, m] of (members ?? []).entries()) {
    if (seen.has(m.id))
      ctx.addIssue({
        code: 'custom',
        path: ['members', i, 'id'],
        message: `two members are ${m.id}`,
      })
    seen.add(m.id)
  }
}

export const ChatRoomSetupSchema = ChatRoomSetupFieldsSchema.superRefine((s, ctx) =>
  uniqueMembers(s.members, ctx),
)
export type ChatRoomSetup = z.infer<typeof ChatRoomSetupSchema>

/** rooms.update's change: any setup fields; `members` replaces the whole list, null clears a folder or draft. */
export const ChatRoomSetupPatchSchema = ChatRoomSetupFieldsSchema.partial()
  .extend({
    folder: ChatRoomSetupFieldsSchema.shape.folder.unwrap().nullable().optional(),
    draft: ChatRoomSetupFieldsSchema.shape.draft.unwrap().nullable().optional(),
  })
  .superRefine((s, ctx) => uniqueMembers(s.members, ctx))
export type ChatRoomSetupPatch = z.infer<typeof ChatRoomSetupPatchSchema>

/** What the members have cost so far, list price from usage: the room's total and each member's. */
export const RoomChatSpendSchema = z.object({
  usd: z.number().min(0),
  byMember: z.record(z.string(), z.number().min(0)),
})
export type RoomChatSpend = z.infer<typeof RoomChatSpendSchema>

/** What a chat room carries on its Room: the setup, how many times it was changed and the spend. */
export const RoomChatSchema = z.object({
  setup: ChatRoomSetupSchema,
  rev: z.number().int().min(0),
  spend: RoomChatSpendSchema.default({ usd: 0, byMember: {} }),
})
export type RoomChat = z.infer<typeof RoomChatSchema>

/** The title of a chat room nobody named yet. */
export const UNTITLED_ROOM = 'New room'
const TITLE_MAX = 60

/** A room's title from Isaac's first message: its first line, cut at a word near TITLE_MAX. */
export function autoTitle(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? ''
  const flat = line.replace(/\s+/g, ' ')
  if (flat === '') return UNTITLED_ROOM
  if (flat.length <= TITLE_MAX) return flat
  const cut = flat.slice(0, TITLE_MAX)
  const space = cut.lastIndexOf(' ')
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, '')}…`
}

/** One model of omp's catalog as far as a setup check needs it (chat.models ModelInfo). */
export interface CatalogModel {
  provider: string
  id: string
  /** Thinking levels it takes, `off` first; empty for a model without reasoning. */
  levels: readonly string[]
}

/** The levels a member on this model may ask for: the model's, or `off` alone without reasoning. */
export const levelsFor = (model: CatalogModel | undefined): readonly string[] =>
  model === undefined || model.levels.length === 0 ? ['off'] : model.levels

/**
 * Why `members` cannot run on omp's catalog (a model it does not list, a thinking level the model
 * does not take), as one line naming the member; null when every member fits.
 */
export function memberProblem(
  members: readonly ChatRoomMember[],
  catalog: readonly CatalogModel[],
): string | null {
  for (const m of members) {
    const model = catalog.find((c) => `${c.provider}/${c.id}` === m.model)
    if (!model) return `${m.name}: ${m.model} is not a model omp lists.`
    const levels = levelsFor(model)
    if (!levels.includes(m.thinking))
      return `${m.name}: ${m.model} takes thinking ${levels.join(', ')}, not ${m.thinking}.`
  }
  return null
}

/** `level` if the model takes it, else the nearest level it does take (ties go up). */
export function fitThinking(level: OmpThinking, levels: readonly string[]): OmpThinking {
  const ok = OMP_THINKING_LEVELS.filter((l) => levels.includes(l))
  if (ok.length === 0) return 'off'
  if (ok.includes(level)) return level
  const want = OMP_THINKING_LEVELS.indexOf(level)
  let best = ok[0]!
  for (const l of ok) {
    const d = Math.abs(OMP_THINKING_LEVELS.indexOf(l) - want)
    const bd = Math.abs(OMP_THINKING_LEVELS.indexOf(best) - want)
    if (d < bd || (d === bd && OMP_THINKING_LEVELS.indexOf(l) > OMP_THINKING_LEVELS.indexOf(best)))
      best = l
  }
  return best
}

/** The effort dial: its name, the budget it suggests and the thinking it gives every member. */
export const ROOM_EFFORTS: readonly { name: string; budget: number; thinking: OmpThinking }[] = [
  { name: 'Quick', budget: 1, thinking: 'low' },
  { name: 'Light', budget: 3, thinking: 'medium' },
  { name: 'Team', budget: 6, thinking: 'high' },
  { name: 'Deep', budget: 10, thinking: 'xhigh' },
  { name: 'Max', budget: 15, thinking: 'max' },
]

/** A template's member slot: a registry assistant in order, or a custom agent of this name. */
export interface RoomTemplateSlot {
  role: string
  thinking: OmpThinking
  custom?: string
}

export interface RoomTemplateInfo {
  label: string
  desc: string
  effort: number
  budget: number
  slots: readonly RoomTemplateSlot[]
}

/** Presets the New room form starts from; everything they fill in stays editable. */
export const ROOM_TEMPLATES: Record<RoomTemplate, RoomTemplateInfo> = {
  debate: {
    label: 'Debate',
    desc: 'Two sides argue, a judge pins the call.',
    effort: 3,
    budget: 3,
    slots: [
      { role: 'Argue for', thinking: 'high' },
      { role: 'Argue against', thinking: 'high' },
      { role: 'Judge', thinking: 'medium' },
    ],
  },
  council: {
    label: 'Council',
    desc: 'Several voices weigh in, one decision pinned.',
    effort: 4,
    budget: 6,
    slots: [
      { role: 'Researcher', thinking: 'high' },
      { role: 'Strategist', thinking: 'high' },
      { role: 'Design lens', thinking: 'medium' },
      { role: 'Chair', thinking: 'medium' },
    ],
  },
  build: {
    label: 'Build team',
    desc: 'Planner splits work, builders ship parts, reviewer checks.',
    effort: 5,
    budget: 12,
    slots: [
      { role: 'Planner', thinking: 'high' },
      { role: 'Implements parts', thinking: 'medium', custom: 'Builder' },
      { role: 'Reviews diffs', thinking: 'high', custom: 'Reviewer' },
    ],
  },
  blank: {
    label: 'Blank',
    desc: 'Start empty and add anyone.',
    effort: 3,
    budget: 3,
    slots: [{ role: '', thinking: 'medium', custom: 'Agent 1' }],
  },
}

/** The instructions a role starts with (the member's own text replaces them). */
export const ROLE_INSTRUCTIONS: Readonly<Record<string, string>> = {
  'Argue for': 'Make the strongest case for the proposal; concede only on evidence.',
  'Argue against': 'Make the strongest case against; demand numbers.',
  Judge: 'Summarise each round, pin the decision.',
  Researcher: 'Dig up facts and cite sources before opining.',
  Strategist: 'Weigh tradeoffs and name the revisit trigger.',
  'Design lens': 'Judge everything by what the user will see.',
  Chair: 'Keep rounds on topic, call the decision.',
  Planner: 'Split work into parts and assign them.',
  'Implements parts': 'Write the code for assigned parts only.',
  'Reviews diffs': 'Review every diff before it merges.',
}

/** `Drive Buddy` -> `drive-buddy`, made unique against `taken` (`builder-2`). */
export function memberIdFor(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'agent'
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

/** A registry assistant as a template fills a slot with it. */
export interface TemplateAssistant {
  id: string
  title: string
}

/**
 * A template's members: its assistant slots take the registry's assistants in order (a slot left
 * over becomes a custom agent), each on the model `modelFor` picks and the slot's thinking fitted
 * to that model, with the role's instructions.
 */
export function templateMembers(
  template: RoomTemplate,
  assistants: readonly TemplateAssistant[],
  modelFor: (assistant: string | null) => CatalogModel,
): ChatRoomMember[] {
  const taken = new Set<string>()
  let next = 0
  return ROOM_TEMPLATES[template].slots.map((slot, i) => {
    const a = slot.custom === undefined ? assistants[next++] : undefined
    const model = modelFor(a?.id ?? null)
    const name = a?.title ?? slot.custom ?? `Agent ${i + 1}`
    const id = a ? a.id : memberIdFor(name, taken)
    taken.add(id)
    const instructions = ROLE_INSTRUCTIONS[slot.role]
    return {
      id,
      ...(a ? { assistant: a.id } : {}),
      name,
      model: `${model.provider}/${model.id}`,
      thinking: fitThinking(slot.thinking, levelsFor(model)),
      role: slot.role,
      ...(instructions ? { instructions } : {}),
    }
  })
}
