import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { nativeImage } from 'electron'
import {
  memberProblem,
  roomActivity,
  roomIsLive,
  type ChatRoomSetup,
  type ChatRoomSetupPatch,
  type Room,
} from '@evaos/contract'
import { REGISTRY_FILE, parseRegistry } from '../assistants/assistants'
import { catalogFor } from '../chat/live-ipc'
import type { MainContext } from '../context'
import { buildCommand, childPathFor, runCapture } from '../eva/spawn'
import { evaFsFor } from '../eva/runtime'
import { emit, handle } from '../ipc/handle'
import { ChatRoom, type ChatRoomDeps } from './chat-room'
import { findClaude, findCodex } from './council/bins'
import { CouncilSession, type CouncilDeps } from './council/council'
import { createSeatLauncher } from './council/seat'
import { newRoomId, readRoomStates } from './council/state'
import { roomImagePath } from './council/workdir'
import { roomStem, saveRoom } from './save'
import type { RoomsCreateInput, RoomsErrorCode, RoomsService } from './service'

/** Streaming replies change a room many times a second; the renderer gets one room per burst. */
const EMIT_MS = 50
const JOURNAL_TIMEOUT_MS = 15_000
/** Each live room is several agent processes; more than this and the machine is the room. */
export const MAX_LIVE_ROOMS = 3
/** Longest side of a room image sent to a client, bounds included. */
const IMAGE_MIN = 64
const IMAGE_MAX = 2048

const fail = (code: RoomsErrorCode, message: string): Error =>
  Object.assign(new Error(message), { code })

/**
 * `rooms.*`: the rooms of this app. Council rooms (seats in worktrees) and chat rooms (Assistants >
 * Rooms) both keep their state in `<eva>/work/rooms/<id>/room.json`, so the ones found there at
 * launch are listed again: a council room resumes where it stopped, a chat room is as it was.
 * Returns the same rooms as a service for the phone's bridge.
 */
export function registerRoomsIpc(ctx: MainContext): RoomsService {
  const { evaRoot, ompBin, live } = ctx.env
  const roomsDir = path.join(evaRoot, 'work', 'rooms')
  const log = (line: string): void => console.info(`[rooms] ${line}`)
  const claudeBin = ctx.env.claudeBin || (live ? findClaude() : null)
  const codexBin = process.env.EVAOS_CODEX_BIN || (live ? findCodex() : null)
  const launcher = createSeatLauncher({
    ompBin,
    ...(claudeBin ? { claudeBin } : {}),
    ...(codexBin ? { codexBin } : {}),
    // Tests run every seat in omp on a cheap model.
    ...(process.env.EVAOS_ROOMS_SEAT_MODEL ? { ompModel: process.env.EVAOS_ROOMS_SEAT_MODEL } : {}),
    log,
  })
  const sessions = new Map<string, CouncilSession | ChatRoom>()
  const pending = new Map<string, NodeJS.Timeout>()
  const listeners = new Set<(room: Room) => void>()
  const removeListeners = new Set<(roomId: string) => void>()

  const onChange = (room: Room): void => {
    if (pending.has(room.id)) return
    pending.set(
      room.id,
      setTimeout(() => {
        pending.delete(room.id)
        emit(ctx, 'rooms.changed', { room })
        for (const cb of listeners) cb(room)
      }, EMIT_MS),
    )
  }

  const journal = async (heading: string, bullets: string[]): Promise<void> => {
    const home = os.homedir()
    const cmd = buildCommand(
      path.join(evaRoot, '.omp/tools/journal-add.ts'),
      [heading, ...bullets],
      {
        pathEnv: await childPathFor(live, home),
        homedir: home,
        execPath: process.execPath,
        baseEnv: process.env,
      },
    )
    const r = await runCapture(cmd, evaRoot, JOURNAL_TIMEOUT_MS)
    if (r.code !== 0)
      throw new Error(`journal-add exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`)
  }

  const session = (roomId: string): CouncilSession | ChatRoom => {
    const s = sessions.get(roomId)
    if (!s) throw fail('no-room', `No room ${roomId}`)
    return s
  }

  const council = (roomId: string): CouncilSession => {
    const s = session(roomId)
    if (!(s instanceof CouncilSession)) throw fail('not-council', 'This room has no effort dial.')
    return s
  }

  const chat = (roomId: string): ChatRoom => {
    const s = session(roomId)
    if (!(s instanceof ChatRoom)) throw fail('not-chat', 'This room has no member setup.')
    return s
  }

  /** Every member's model is one omp lists, at a thinking level that model takes. */
  const checkMembers = async (setup: Pick<ChatRoomSetup, 'members'>): Promise<void> => {
    const models = await catalogFor(ctx)
      .list()
      .catch((e: unknown) => {
        throw fail(
          'bad-input',
          `Could not read omp's models: ${e instanceof Error ? e.message : String(e)}`,
        )
      })
    const problem = memberProblem(setup.members, models)
    if (problem) throw fail('bad-input', problem)
  }

  const evaFs = evaFsFor(ctx)
  const save = (room: Room, stem?: string): Promise<string> =>
    saveRoom(room, { evaRoot, evaFs, journal }, stem)
  const councilDeps: CouncilDeps = {
    launcher,
    evaRoot,
    stem: (room) => roomStem(evaRoot, room),
    save,
    writeRouting: (rel, content) => evaFs.write('room-routing', rel, content),
    onChange,
    log,
  }
  const chatDeps: ChatRoomDeps = {
    evaRoot,
    onChange,
    log,
    launcher,
    catalog: () => catalogFor(ctx).list(),
    assistants: () => {
      try {
        return parseRegistry(fs.readFileSync(path.join(evaRoot, REGISTRY_FILE), 'utf8'))
      } catch {
        return []
      }
    },
  }
  const liveRooms = (): number =>
    [...sessions.values()].filter((s) => roomIsLive(s.room.phase)).length

  // Rooms an earlier run of the app saved: listed again, council ones resumable.
  for (const state of readRoomStates(roomsDir, log)) {
    const s =
      'kind' in state
        ? ChatRoom.restore(state, chatDeps)
        : new CouncilSession(state.room.prompt, state.input, councilDeps, state)
    sessions.set(s.room.id, s)
  }

  const added = (s: CouncilSession | ChatRoom): string => {
    sessions.set(s.room.id, s)
    onChange(s.room)
    return s.room.id
  }

  const service: RoomsService = {
    list: () =>
      [...sessions.values()].map((s) => s.room).sort((a, b) => roomActivity(b) - roomActivity(a)),
    onChange: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    onRemove: (cb) => {
      removeListeners.add(cb)
      return () => removeListeners.delete(cb)
    },
    async create(input: RoomsCreateInput) {
      if (liveRooms() >= MAX_LIVE_ROOMS) {
        throw fail(
          'too-many-rooms',
          `${MAX_LIVE_ROOMS} rooms are already live. Resolve one before starting another.`,
        )
      }
      const s = new CouncilSession(input.prompt, input.council, councilDeps)
      const roomId = added(s)
      void s.start()
      return { roomId }
    },
    async open(setup) {
      await checkMembers(setup)
      const now = Date.now()
      return { roomId: added(ChatRoom.create(newRoomId(now), setup, now, chatDeps)) }
    },
    async update(roomId, patch: ChatRoomSetupPatch) {
      const room = chat(roomId)
      if (patch.members) await checkMembers({ members: patch.members })
      return room.update(patch)
    },
    rename: (roomId, title) => session(roomId).rename(title),
    duplicate(roomId) {
      const { setup } = chat(roomId)
      const copy = {
        ...structuredClone(setup),
        ...(setup.title ? { title: `${setup.title} copy` } : {}),
      }
      const now = Date.now()
      return { roomId: added(ChatRoom.create(newRoomId(now), copy, now, chatDeps)) }
    },
    async delete(roomId) {
      const s = session(roomId)
      await s.destroy()
      sessions.delete(roomId)
      clearTimeout(pending.get(roomId))
      pending.delete(roomId)
      // Only ever the room's own folder: its id names one directory right under work/rooms.
      const dir = path.join(roomsDir, roomId)
      if (path.dirname(dir) === roomsDir) fs.rmSync(dir, { recursive: true, force: true })
      emit(ctx, 'rooms.removed', { roomId })
      for (const cb of removeListeners) cb(roomId)
    },
    post: (roomId, text) => session(roomId).post(text),
    react: (roomId, messageId, emoji) => session(roomId).react(messageId, emoji),
    stop: (roomId) => council(roomId).stop(),
    pause: (roomId) => session(roomId).pause(),
    async resume(roomId) {
      const s = session(roomId)
      if (s instanceof ChatRoom) return s.resume()
      if (!s.resumable) throw fail('bad-input', 'The room is running.')
      if (liveRooms() >= MAX_LIVE_ROOMS) {
        throw fail(
          'too-many-rooms',
          `${MAX_LIVE_ROOMS} rooms are already live. Pause or resolve one before resuming another.`,
        )
      }
      return s.resume()
    },
    raise: async (roomId) => council(roomId).raise(),
    budget: async (roomId, choice) => council(roomId).budget(choice),
    answer: (roomId, askId, allow) => council(roomId).answer(askId, allow),
    async image(roomId, p, max) {
      const c = council(roomId).room.council!
      const img = nativeImage.createFromPath(roomImagePath(c.workdir, c.refs, p))
      if (img.isEmpty()) throw fail('bad-path', `Could not read ${p}`)
      const side = Math.max(IMAGE_MIN, Math.min(IMAGE_MAX, Math.round(max)))
      const { width, height } = img.getSize()
      const scale = Math.min(1, side / Math.max(width, height))
      const out =
        scale < 1
          ? img.resize({
              width: Math.round(width * scale),
              height: Math.round(height * scale),
              quality: 'good',
            })
          : img
      return `data:image/jpeg;base64,${out.toJPEG(85).toString('base64')}`
    },
  }

  handle(ctx, 'rooms.create', (input) => service.create(input))
  handle(ctx, 'rooms.open', ({ setup }) => service.open(setup))
  handle(ctx, 'rooms.update', async ({ roomId, setup }) => ({
    roomId,
    rev: await service.update(roomId, setup),
  }))
  handle(ctx, 'rooms.rename', ({ roomId, title }) => {
    service.rename(roomId, title)
    return { renamed: true as const }
  })
  handle(ctx, 'rooms.duplicate', ({ roomId }) => service.duplicate(roomId))
  handle(ctx, 'rooms.delete', async ({ roomId }) => {
    await service.delete(roomId)
    return { deleted: true as const }
  })
  handle(ctx, 'rooms.post', ({ roomId, text }) => {
    service.post(roomId, text)
    return { posted: true as const }
  })
  handle(ctx, 'rooms.react', ({ roomId, messageId, emoji }) => {
    service.react(roomId, messageId, emoji)
    return { reacted: true as const }
  })
  handle(ctx, 'rooms.stop', async ({ roomId }) => {
    await service.stop(roomId)
    return { stopped: true as const }
  })
  handle(ctx, 'rooms.pause', ({ roomId }) => {
    service.pause(roomId)
    return { pausing: true as const }
  })
  handle(ctx, 'rooms.resume', async ({ roomId }) => ({ cap: await service.resume(roomId) }))
  handle(ctx, 'rooms.raise', async ({ roomId }) => ({ effort: await service.raise(roomId) }))
  handle(ctx, 'rooms.budget', async ({ roomId, choice }) => ({
    cap: await service.budget(roomId, choice),
  }))
  handle(ctx, 'rooms.answer', ({ roomId, askId, allow }) => {
    service.answer(roomId, askId, allow)
    return { answered: true as const }
  })
  handle(ctx, 'rooms.list', () => ({ rooms: service.list() }))

  // On a normal quit this hook saves every running council room as paused (it resumes at the
  // round it was in) and ends every process (stdin EOF, then SIGTERM, then SIGKILL to its process
  // group, so tool children go too), waiting for the exits (bounded, inside the 12 s quit cap).
  // If main is hard killed or crashes, no hook runs: the room comes back paused from its last
  // save at the next launch; the children's stdin pipe closes and omp exits on EOF when idle
  // (observed), but a seat mid-tool, or a tool child that outlives it, can linger until it
  // finishes. Chat rooms are on disk after every change.
  ctx.onBeforeQuit(async () => {
    for (const t of pending.values()) clearTimeout(t)
    await Promise.allSettled([...sessions.values()].map((s) => s.destroy()))
  })
  return service
}
