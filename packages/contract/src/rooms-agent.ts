import { z } from 'zod'
import {
  ChatRoomSetupFieldsSchema,
  OmpModelIdSchema,
  OmpThinkingSchema,
  ROOM_EFFORTS,
  ROOM_MAX_MEMBERS,
  fitThinking,
  levelsFor,
  memberIdFor,
  type CatalogModel,
  type ChatRoomMember,
  type RoomChat,
  type RoomLimits,
} from './rooms-chat'

// ---------------------------------------------------------------------------------------------
// Rooms an assistant sets up from a conversation (agent actions rooms.create / rooms.update /
// rooms.list, relay MCP `rooms_create`..., `relay-linux rooms ...` on the host). The assistant names
// members by assistant id or a custom name; main resolves them against the registry, checks every
// model against omp's catalog and holds the room to ASSISTANT_ROOM_LIMITS. Its reply carries the
// card token, which Relay draws as a live card of the room.
// ---------------------------------------------------------------------------------------------

/**
 * The most an assistant may give a room it sets up or changes: the budget cap in USD and the
 * effort notch (4 = Deep). Isaac's own edits of a room lift its limits to what he set. Isaac's
 * decision to confirm (HANDOFF.md S5 "Bounds").
 */
export const ASSISTANT_ROOM_LIMITS: RoomLimits = { budget: 10, effort: 4 }

const coded = (message: string): Error => Object.assign(new Error(message), { code: 'bad-input' })

/** A member as an assistant names it: an assistant from the registry, or a custom agent. */
export const RoomsAgentMemberSchema = z
  .object({
    assistant: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/)
      .optional()
      .describe('An assistant id (relay-linux assistant list): that assistant sits in the room'),
    custom: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .optional()
      .describe('Else a custom agent: its name ("Sol", "Builder")'),
    model: OmpModelIdSchema.describe(
      'The exact omp model id, provider/id (as `omp --list-models` prints it)',
    ),
    thinking: OmpThinkingSchema.describe('Its thinking level; the model must take it'),
    role: z.string().trim().max(80).describe('What it does here ("Critic", "Argue for"); may be ""'),
    instructions: z.string().trim().min(1).max(4000).optional(),
  })
  .strict()
export type RoomsAgentMember = z.infer<typeof RoomsAgentMemberSchema>

/** What `replace.to` changes on a member; the rest (role, instructions, thinking) carries over. */
export const RoomsAgentMemberPatchSchema = RoomsAgentMemberSchema.partial()
export type RoomsAgentMemberPatch = z.infer<typeof RoomsAgentMemberPatchSchema>

/** A member id or name (case-insensitive, the first name will do). */
const MemberRef = z.string().trim().min(1).max(64)

export const RoomsMembersChangeSchema = z
  .object({
    add: z.array(RoomsAgentMemberSchema).min(1).max(ROOM_MAX_MEMBERS).optional(),
    remove: z.array(MemberRef).min(1).max(ROOM_MAX_MEMBERS).optional(),
    replace: z.object({ from: MemberRef, to: RoomsAgentMemberPatchSchema }).strict().optional(),
  })
  .strict()
export type RoomsMembersChange = z.infer<typeof RoomsMembersChangeSchema>

const F = ChatRoomSetupFieldsSchema.shape

/** rooms.create's fields (agent.ts adds `scope`). */
export const RoomsCreateFields = {
  title: F.title,
  members: z.array(RoomsAgentMemberSchema).min(1).max(ROOM_MAX_MEMBERS),
  effort: F.effort.describe('1..5 (Quick, Light, Team, Deep, Max): turns per message of Isaac'),
  budget: F.budget.describe('The hard cap in USD; the room pauses itself before crossing it'),
  folder: F.folder,
  refs: F.refs.optional(),
  draft: F.draft.describe('A first message, prefilled in the room composer and never sent'),
  template: F.template.optional(),
  proposal: z
    .boolean()
    .optional()
    .describe(
      'Propose it as a council instead: the card asks Isaac to Convene (his click sends `draft`, the question), Edit members or Not now',
    ),
}

/** rooms.update's fields (agent.ts adds `scope`). */
export const RoomsUpdateFields = {
  roomId: z.string().min(1).max(64),
  title: F.title,
  members: z
    .union([z.array(RoomsAgentMemberSchema).min(1).max(ROOM_MAX_MEMBERS), RoomsMembersChangeSchema])
    .optional()
    .describe('A full list replaces the members; {add, remove, replace:{from, to}} changes some'),
  effort: F.effort.optional(),
  budget: F.budget.optional(),
  folder: F.folder.unwrap().nullable().optional(),
  refs: F.refs.optional(),
  draft: F.draft.unwrap().nullable().optional(),
  template: F.template.optional(),
}

/** The card token an assistant's reply carries for a room (its own line). */
export const roomCardToken = (roomId: string, title?: string): string =>
  `[[room:${roomId}${title ? ` | ${title.replace(/[[\]\n|]/g, ' ').trim()}` : ''}]]`

/** The room's place as a deep link (`room:<id>`). */
export const roomLink = (roomId: string): string => `relay://open/room/${roomId}`

/** A registry assistant as a room resolves it. */
export interface AgentRoomAssistant {
  id: string
  title: string
}

const firstName = (name: string): string => name.trim().toLowerCase().split(/\s+/)[0] ?? ''

/** The member `ref` names: its id, its name, or its first name (case-insensitive). */
function findMember(members: readonly ChatRoomMember[], ref: string): number {
  const r = ref.trim().toLowerCase()
  const exact = members.findIndex((m) => m.id === r || m.name.toLowerCase() === r)
  if (exact >= 0) return exact
  const byFirst = members.flatMap((m, i) => (firstName(m.name) === r ? [i] : []))
  if (byFirst.length === 1) return byFirst[0]!
  throw coded(
    byFirst.length > 1
      ? `${ref} names more than one member; use the member id (${byFirst.map((i) => members[i]!.id).join(', ')})`
      : `No member ${ref} in this room; members: ${members.map((m) => `${m.name} (${m.id})`).join(', ')}`,
  )
}

/** One named member as the room keeps it; `taken` gets its id. */
export function resolveMember(
  input: RoomsAgentMember,
  assistants: readonly AgentRoomAssistant[],
  taken: Set<string>,
): ChatRoomMember {
  if ((input.assistant === undefined) === (input.custom === undefined))
    throw coded('Each member is an `assistant` (an id) or a `custom` name, not both or neither.')
  let name: string
  let assistant: string | undefined
  if (input.assistant !== undefined) {
    const a = assistants.find((x) => x.id === input.assistant)
    if (!a)
      throw coded(
        `No assistant ${input.assistant}; try ${assistants.map((x) => x.id).join(', ') || 'a custom member'}`,
      )
    assistant = a.id
    name = a.title
  } else name = input.custom!
  const id = assistant !== undefined && !taken.has(assistant) ? assistant : memberIdFor(name, taken)
  taken.add(id)
  return {
    id,
    ...(assistant !== undefined ? { assistant } : {}),
    name,
    model: input.model,
    thinking: input.thinking,
    role: input.role,
    ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
  }
}

export function resolveMembers(
  inputs: readonly RoomsAgentMember[],
  assistants: readonly AgentRoomAssistant[],
): ChatRoomMember[] {
  const taken = new Set<string>()
  return inputs.map((m) => resolveMember(m, assistants, taken))
}

/**
 * The members after `change`: a list replaces them; else `remove`, then `replace` (the new one
 * keeps the old one's place, role, instructions and thinking, fitted to a new model, unless `to`
 * names them), then `add`. A name that matches no member, or the last member leaving, is refused.
 */
export function changeMembers(
  current: readonly ChatRoomMember[],
  change: readonly RoomsAgentMember[] | RoomsMembersChange,
  assistants: readonly AgentRoomAssistant[],
  catalog: readonly CatalogModel[],
): ChatRoomMember[] {
  if (Array.isArray(change)) return resolveMembers(change, assistants)
  const c = change as RoomsMembersChange
  if (!c.add && !c.remove && !c.replace) throw coded('members: give add, remove or replace.')
  let members = [...current]
  for (const ref of c.remove ?? []) {
    const i = findMember(members, ref)
    members = members.filter((_, j) => j !== i)
  }
  if (c.replace) {
    const i = findMember(members, c.replace.from)
    const old = members[i]!
    const to = c.replace.to
    const taken = new Set(members.filter((_, j) => j !== i).map((m) => m.id))
    const renamed = to.assistant !== undefined || to.custom !== undefined
    const model = to.model ?? old.model
    const spec = catalog.find((m) => `${m.provider}/${m.id}` === model)
    const thinking =
      to.thinking ??
      (model === old.model ? old.thinking : fitThinking(old.thinking, levelsFor(spec)))
    const next = renamed
      ? resolveMember(
          {
            ...(to.assistant !== undefined ? { assistant: to.assistant } : { custom: to.custom }),
            model,
            thinking,
            role: to.role ?? old.role,
            ...((to.instructions ?? old.instructions) !== undefined
              ? { instructions: to.instructions ?? old.instructions }
              : {}),
          },
          assistants,
          taken,
        )
      : {
          ...old,
          model,
          thinking,
          ...(to.role !== undefined ? { role: to.role } : {}),
          ...(to.instructions !== undefined ? { instructions: to.instructions } : {}),
        }
    members = members.map((m, j) => (j === i ? next : m))
  }
  if (c.add) {
    const taken = new Set(members.map((m) => m.id))
    members = [...members, ...c.add.map((m) => resolveMember(m, assistants, taken))]
  }
  if (members.length === 0) throw coded('A room keeps at least one member.')
  if (members.length > ROOM_MAX_MEMBERS) throw coded(`A room holds at most ${ROOM_MAX_MEMBERS} members.`)
  return members
}

/**
 * What an assistant may set budget and effort to in this room: its limits, else (a room Isaac set
 * up) ASSISTANT_ROOM_LIMITS or what Isaac set, whichever is higher.
 */
export function assistantCeiling(chat: Pick<RoomChat, 'limits' | 'setup'>): RoomLimits {
  return (
    chat.limits ?? {
      budget: Math.max(ASSISTANT_ROOM_LIMITS.budget, chat.setup.budget),
      effort: Math.max(ASSISTANT_ROOM_LIMITS.effort, chat.setup.effort),
    }
  )
}

/** The limits after Isaac saved `setup`: raised to what he set, never lowered. */
export const isaacLimits = (
  limits: RoomLimits | undefined,
  setup: { budget: number; effort: number },
): RoomLimits | undefined =>
  limits && {
    budget: Math.max(limits.budget, setup.budget),
    effort: Math.max(limits.effort, setup.effort),
  }

/** Why an assistant may not set these values; null when they fit. */
export function boundsProblem(
  want: { budget?: number | undefined; effort?: number | undefined },
  ceiling: RoomLimits,
): string | null {
  const over: string[] = []
  if (want.budget !== undefined && want.budget > ceiling.budget)
    over.push(`budget $${want.budget} is over $${ceiling.budget}`)
  if (want.effort !== undefined && want.effort > ceiling.effort)
    over.push(
      `effort ${want.effort} is over ${ceiling.effort} (${ROOM_EFFORTS[ceiling.effort - 1]?.name ?? ceiling.effort})`,
    )
  return over.length === 0
    ? null
    : `An assistant's room stays within $${ceiling.budget} and effort ${ceiling.effort}: ${over.join('; ')}. Ask Isaac to raise it in Edit setup.`
}
