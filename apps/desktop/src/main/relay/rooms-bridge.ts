// Rooms on the phone through the Relay Host (@relay/protocol ROOMS_FEATURE). On a host whose
// welcome lists "rooms" this app sends every room it runs (`rooms.sync`) on each (re)connect, then
// each changed room (`rooms.upsert`, at most one per room every UPSERT_EVERY_MS, the last change
// always included); a deleted room goes with a fresh `rooms.sync` (the host replaces this Mac's
// rooms with it). The host's `rooms.cmd` (a phone's command) runs on the same RoomsService the
// renderer's IPC uses and goes back as `rooms.res` with the same rid. Older hosts get nothing; a
// host without ROOMS_RESUME_FEATURE refuses the `paused` phase, so it sees paused rooms as resolved.
//
// Chat rooms (Assistants > Rooms) go out only to a host with ROOMS_CHAT_FEATURE: every older Relay
// Host refuses a room in the `idle` phase (its RoomWireSchema knows five phases and drops the
// socket over a frame it refuses). That host hands them only to phones that can draw them.
import { roomsInvoke, type Room } from '@evaos/contract'
import {
  MAX_ROOMS,
  ROOMS_CHAT_FEATURE,
  ROOMS_FEATURE,
  ROOMS_RESUME_FEATURE,
  RoomsCmd,
  RoomsRid,
  type RoomsResult,
} from '@relay/protocol'
import type { RelayFeatures, RelayFrames } from './client'
import type { RoomsService } from '../rooms/service'

/** A long streaming turn changes a room many times a second: the tailnet hears it this often. */
export const UPSERT_EVERY_MS = 250

export interface RoomsBridge {
  stop(): void
}

async function run(service: RoomsService, cmd: RoomsCmd): Promise<unknown> {
  switch (cmd.op) {
    case 'create': {
      // The IPC schema fills defaults (refs) the phone may leave out.
      const input = roomsInvoke['rooms.create'].input.safeParse({
        prompt: cmd.prompt,
        council: cmd.council,
      })
      if (!input.success)
        throw Object.assign(new Error(input.error.issues[0]?.message ?? 'Bad room'), {
          code: 'bad-input',
        })
      return service.create(input.data)
    }
    case 'post':
      return service.post(cmd.roomId, cmd.text)
    case 'react':
      return service.react(cmd.roomId, cmd.messageId, cmd.emoji)
    case 'stop':
      return service.stop(cmd.roomId)
    case 'pause':
      return service.pause(cmd.roomId)
    case 'resume':
      return service.resume(cmd.roomId)
    case 'raise':
      return service.raise(cmd.roomId)
    case 'budget':
      return service.budget(cmd.roomId, cmd.choice)
    case 'answer':
      return service.answer(cmd.roomId, cmd.askId, cmd.allow)
    case 'vote':
      return service.vote(cmd.roomId, cmd.cardId, cmd.option)
    case 'callPoll':
      return service.callPoll(cmd.roomId, cmd.cardId, cmd.option)
    case 'reopenPoll':
      return service.reopenPoll(cmd.roomId, cmd.cardId)
    case 'answerAsk':
      return service.answerAsk(cmd.roomId, cmd.cardId, cmd.answer)
    case 'decide':
      return service.decide(cmd.roomId, cmd.cardId, cmd.action, cmd.option)
    case 'image':
      return service.image(cmd.roomId, cmd.path, cmd.max)
  }
}

/** The host drops a connection over a frame its schema refuses: keep codes and messages in bounds. */
function failure(e: unknown): RoomsResult {
  const code =
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    typeof e.code === 'string' &&
    e.code !== ''
      ? e.code
      : 'error'
  const message = e instanceof Error ? e.message : String(e)
  return { ok: false, code: code.slice(0, 64), message: message.slice(0, 4000) }
}

export function startRoomsBridge(deps: {
  client: RelayFrames & RelayFeatures
  service: RoomsService
  now?: () => number
}): RoomsBridge {
  const { client, service } = deps
  const now = deps.now ?? Date.now
  let enabled = false
  /** The host takes the `paused` phase (and relays pause / resume). */
  let resumeHost = false
  /** The host takes chat rooms and the `idle` phase. */
  let chatHost = false
  const sent = (room: Room): boolean => room.kind === 'council' || chatHost
  /** What the phone may see: a paused room as resolved on an older host. */
  const wire = (room: Room): Room =>
    resumeHost || room.phase !== 'paused' ? room : { ...room, phase: 'resolved' }
  const shared = (): Room[] => service.list().filter(sent).slice(0, MAX_ROOMS).map(wire)
  /** Per room: when it last went out, and the timer holding its latest change. */
  const sentAt = new Map<string, number>()
  const timers = new Map<string, NodeJS.Timeout>()

  const clearTimers = (): void => {
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
  }

  const upsert = (roomId: string): void => {
    timers.delete(roomId)
    if (!enabled) return
    const room = service.list().find((r) => r.id === roomId)
    if (room === undefined || !sent(room)) return
    sentAt.set(roomId, now())
    client.sendFrame({ t: 'rooms.upsert', room: wire(room) })
  }

  const offChange = service.onChange((room) => {
    if (!enabled || !sent(room) || timers.has(room.id)) return
    const wait = (sentAt.get(room.id) ?? Number.NEGATIVE_INFINITY) + UPSERT_EVERY_MS - now()
    if (wait <= 0) upsert(room.id)
    else
      timers.set(
        room.id,
        setTimeout(() => upsert(room.id), wait),
      )
  })

  const offRemove = service.onRemove((roomId) => {
    if (!enabled) return
    clearTimeout(timers.get(roomId))
    timers.delete(roomId)
    sentAt.delete(roomId)
    client.sendFrame({ t: 'rooms.sync', rooms: shared() })
  })

  const answer = async (rid: string, cmd: RoomsCmd): Promise<void> => {
    let result: RoomsResult
    try {
      const value = await run(service, cmd)
      result = value === undefined ? { ok: true } : { ok: true, value }
    } catch (e) {
      result = failure(e)
    }
    client.sendFrame({ t: 'rooms.res', rid, result })
  }

  const offFrame = client.onFrame((f) => {
    if (f.t === 'welcome') {
      enabled = client.hostHas(ROOMS_FEATURE)
      resumeHost = client.hostHas(ROOMS_RESUME_FEATURE)
      chatHost = client.hostHas(ROOMS_CHAT_FEATURE)
      clearTimers()
      sentAt.clear()
      if (enabled) client.sendFrame({ t: 'rooms.sync', rooms: shared() })
      return
    }
    if (f.t !== 'rooms.cmd' || !enabled) return
    const rid = RoomsRid.safeParse(f.rid)
    if (!rid.success) return
    const cmd = RoomsCmd.safeParse(f.cmd)
    if (cmd.success) void answer(rid.data, cmd.data)
    else
      client.sendFrame({
        t: 'rooms.res',
        rid: rid.data,
        result: { ok: false, code: 'bad-input', message: 'That command is not one this Mac knows' },
      })
  })

  return {
    stop() {
      offFrame()
      offChange()
      offRemove()
      clearTimers()
    },
  }
}
