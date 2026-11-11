import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { nativeImage } from 'electron'
import {
  ROOM_JUDGE_MODEL,
  roomIsLive,
  roomPerson,
  type Room,
  type RoomAgent,
} from '@evaos/contract'
import { catalogFor } from '../chat/live-ipc'
import type { MainContext } from '../context'
import { buildCommand, childPathFor, runCapture } from '../eva/spawn'
import { evaFsFor } from '../eva/runtime'
import { emit, handle } from '../ipc/handle'
import { findClaude, findCodex } from './council/bins'
import { CouncilSession, type CouncilDeps } from './council/council'
import { createSeatLauncher } from './council/seat'
import { readRoomStates } from './council/state'
import { roomImagePath } from './council/workdir'
import { JevClient, readJevKey } from './jev'
import { RoomSession } from './orchestrator'
import { OmpAgentRunner, privateCwd } from './runner'
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
 * `rooms.*`: the rooms of this app (debate rooms of omp personas, council rooms of seats in
 * worktrees). Debate rooms live for the app session; their record is the file they save on
 * resolve. Council rooms also keep their state in `<eva>/work/rooms/<id>/room.json`, so the ones
 * found there at launch are listed again and resume where they stopped. Returns the same rooms as
 * a service for the phone's bridge.
 */
export function registerRoomsIpc(ctx: MainContext): RoomsService {
  const { evaRoot, ompBin, live } = ctx.env
  // Read-only seats look at real code: the app's own checkout (no .omp inside) when the Eva
  // root has it. Chat-only seats and the judge get an empty private dir: the Eva root's
  // .omp/tools would reach them as project tools no matter the flags.
  const repo = path.join(evaRoot, 'work', 'evaos-electron')
  const toolsCwd = fs.existsSync(repo) ? repo : evaRoot
  const runner = new OmpAgentRunner({ ompBin, live, cwd: privateCwd(os.tmpdir()), toolsCwd })
  const log = (line: string): void => console.info(`[rooms] ${line}`)
  const claudeBin = ctx.env.claudeBin || (live ? findClaude() : null)
  const codexBin = process.env.EVAOS_CODEX_BIN || (live ? findCodex() : null)
  const launcher = createSeatLauncher({
    ompBin,
    ...(claudeBin ? { claudeBin } : {}),
    ...(codexBin ? { codexBin } : {}),
    // Tests run every seat in omp on a cheap model.
    ...(process.env.EVAOS_ROOMS_SEAT_MODEL
      ? { ompModel: process.env.EVAOS_ROOMS_SEAT_MODEL }
      : {}),
    log,
  })
  const sessions = new Map<string, RoomSession | CouncilSession>()
  const order: string[] = []
  const pending = new Map<string, NodeJS.Timeout>()
  const listeners = new Set<(room: Room) => void>()

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

  const session = (roomId: string): RoomSession | CouncilSession => {
    const s = sessions.get(roomId)
    if (!s) throw fail('no-room', `No room ${roomId}`)
    return s
  }

  const council = (roomId: string): CouncilSession => {
    const s = session(roomId)
    if (!(s instanceof CouncilSession)) throw fail('not-council', 'This room has no effort dial.')
    return s
  }

  /** The roster entries asked for; a model missing from omp's catalog fails that agent early. */
  const agentsFor = async (agentIds: string[]): Promise<RoomAgent[]> => {
    const people = agentIds.map((id) => roomPerson(id)).filter((a): a is RoomAgent => a !== null)
    if (people.length === 0) throw fail('bad-input', 'No known agent was picked.')
    const known = await catalogFor(ctx)
      .list()
      .then((models) => new Set(models.map((m) => `${m.provider}/${m.id}`)))
      .catch(() => null)
    if (known === null) return people
    return people.map((a) => (known.has(a.model) ? a : { ...a, failed: true }))
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
  const liveRooms = (): number =>
    [...sessions.values()].filter((s) => roomIsLive(s.room.phase)).length

  // Council rooms an earlier run of the app saved: listed again, newest first, resumable.
  const saved = readRoomStates(path.join(evaRoot, 'work', 'rooms'), log).sort(
    (a, b) => b.room.startedAt - a.room.startedAt,
  )
  for (const state of saved) {
    const s = new CouncilSession(state.room.prompt, state.input, councilDeps, state)
    sessions.set(s.room.id, s)
    order.push(s.room.id)
  }

  const service: RoomsService = {
    list: () => order.map((id) => sessions.get(id)!.room),
    onChange: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    async create(input: RoomsCreateInput) {
      if (liveRooms() >= MAX_LIVE_ROOMS) {
        throw fail(
          'too-many-rooms',
          `${MAX_LIVE_ROOMS} rooms are already live. Resolve one before starting another.`,
        )
      }
      let s: RoomSession | CouncilSession
      if (input.council) {
        s = new CouncilSession(input.prompt, input.council, councilDeps)
      } else if (input.agentIds) {
        const agents = await agentsFor(input.agentIds)
        // The key is read per room (secrets/jev.env may appear later) and lives only in the client.
        const key = readJevKey(evaRoot)
        s = new RoomSession(input.prompt, agents, {
          runner,
          judgeModel: ROOM_JUDGE_MODEL,
          save: (room) => save(room),
          onChange,
          log,
          ...(key ? { jev: new JevClient(key) } : {}),
        })
        if (!key) log(`${s.room.id}: no TYPESAFE_API_KEY, model judge only`)
      } else throw fail('bad-input', 'Pass agentIds or council.')
      sessions.set(s.room.id, s)
      order.unshift(s.room.id)
      onChange(s.room)
      void s.start()
      return { roomId: s.room.id }
    },
    post: (roomId, text) => session(roomId).post(text),
    react: (roomId, messageId, emoji) => session(roomId).react(messageId, emoji),
    stop: (roomId) => session(roomId).stop(),
    pause: (roomId) => council(roomId).pause(),
    async resume(roomId) {
      const s = council(roomId)
      if (!s.resumable) throw fail('bad-input', 'The room is running.')
      if (liveRooms() >= MAX_LIVE_ROOMS) {
        throw fail(
          'too-many-rooms',
          `${MAX_LIVE_ROOMS} rooms are already live. Pause or resolve one before resuming another.`,
        )
      }
      // A resumed room goes back to the top of the list, as a new one would.
      order.splice(order.indexOf(roomId), 1)
      order.unshift(roomId)
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
  // finishes. Debate rooms die with the app.
  ctx.onBeforeQuit(async () => {
    for (const t of pending.values()) clearTimeout(t)
    await Promise.allSettled([...sessions.values()].map((s) => s.destroy()))
  })
  return service
}
