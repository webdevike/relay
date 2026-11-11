// The rooms.* agent actions: an assistant sets up (or proposes) a room from its conversation with
// Isaac and changes it later. Who asked comes from the request's scope (`agent:<id>` for an
// assistant thread, else a chat session file), recorded on the room so its card is attributed.
// The service holds an assistant's values to its limits and checks every model against omp's
// catalog; nothing runs until Isaac sends a message in the room (or convenes a proposal).
import {
  ASSISTANT_ROOM_LIMITS,
  ChatRoomSetupSchema,
  changeMembers,
  resolveMembers,
  roomCardToken,
  roomLink,
  type AgentParams,
  type AgentRoomAssistant,
  type AgentRunners,
  type CatalogModel,
  type ChatRoomSetupPatch,
  type Room,
  type RoomOrigin,
} from '@evaos/contract'
import { canvasCaller } from '../relay/canvas-live-agent'
import type { RoomsService } from './service'

export interface RoomsAgentDeps {
  /** The registry's assistants members can be. */
  assistants: () => readonly AgentRoomAssistant[]
  /** omp's catalog: a replaced member's thinking is fitted to its new model. */
  catalog: () => Promise<readonly CatalogModel[]>
  now?: () => number
}

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code })

/** Who asked, from the request's scope; nothing but the time when the scope names no one. */
export function roomOrigin(scope: string | undefined, at: number): RoomOrigin {
  if (scope === undefined) return { at }
  try {
    const caller = canvasCaller(scope)
    return 'assistant' in caller
      ? { assistant: caller.assistant, at }
      : { session: caller.sessionFile, at }
  } catch {
    return { at }
  }
}

/** One room as rooms.list answers it. */
function listed(room: Room) {
  const chat = room.chat
  return {
    roomId: room.id,
    title: room.title,
    kind: room.kind,
    phase: room.phase,
    link: roomLink(room.id),
    messages: room.messages.length,
    ...(chat
      ? {
          members: chat.setup.members.map((m) => ({
            id: m.id,
            name: m.name,
            ...(m.assistant ? { assistant: m.assistant } : {}),
            model: m.model,
            thinking: m.thinking,
            role: m.role,
          })),
          effort: chat.setup.effort,
          budget: chat.setup.budget,
          spent: Math.round(chat.spend.usd * 100) / 100,
          rev: chat.rev,
          ...(chat.by ? { by: chat.by } : {}),
          card: roomCardToken(room.id, chat.setup.title),
        }
      : {}),
  }
}

export function roomsRunners(
  rooms: RoomsService,
  deps: RoomsAgentDeps,
): Pick<AgentRunners<'main'>, 'rooms.create' | 'rooms.update' | 'rooms.list'> {
  const now = deps.now ?? Date.now
  return {
    'rooms.create': async (params: AgentParams<'rooms.create'>) => {
      const { scope, members, proposal, template, refs, ...fields } = params
      const parsed = ChatRoomSetupSchema.safeParse({
        ...fields,
        template: template ?? (proposal ? 'council' : 'blank'),
        refs: refs ?? [],
        members: resolveMembers(members, deps.assistants()),
      })
      if (!parsed.success) throw fail('invalid-params', parsed.error.message)
      const by = roomOrigin(scope, now())
      const { roomId } = await rooms.open(parsed.data, {
        by,
        limits: { ...ASSISTANT_ROOM_LIMITS },
        ...(proposal ? { proposal: true } : {}),
      })
      const card = roomCardToken(roomId, parsed.data.title)
      return {
        roomId,
        link: roomLink(roomId),
        state: proposal ? 'proposed' : 'idle',
        card,
        next: proposal
          ? `Put ${card} on its own line in your reply: Isaac sees the proposal there (Convene, Edit members, Not now). Nothing runs until he convenes it.`
          : `Put ${card} on its own line in your reply: Isaac sees the Room ready card there (Open room, Edit setup). Nobody speaks until he sends a message in the room.`,
      }
    },
    'rooms.update': async (params: AgentParams<'rooms.update'>) => {
      const { scope, roomId, members, ...fields } = params
      const room = rooms.list().find((r) => r.id === roomId)
      if (!room) throw fail('no-room', `No room ${roomId}; rooms.list lists them`)
      if (!room.chat) throw fail('not-chat', 'A council room has no member setup to change.')
      const patch: ChatRoomSetupPatch = { ...fields }
      if (members !== undefined)
        patch.members = changeMembers(
          room.chat.setup.members,
          members,
          deps.assistants(),
          await deps.catalog().catch(() => []),
        )
      const rev = await rooms.update(roomId, patch, roomOrigin(scope, now()))
      return { roomId, link: roomLink(roomId), rev }
    },
    'rooms.list': () => ({ rooms: rooms.list().map(listed) }),
  }
}
