import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ROOM_JUDGE_MODEL, roomPerson, type Room, type RoomAgent } from '@evaos/contract'
import { catalogFor } from '../chat/live-ipc'
import type { MainContext } from '../context'
import { buildCommand, childPathFor, runCapture } from '../eva/spawn'
import { evaFsFor } from '../eva/runtime'
import { emit, handle } from '../ipc/handle'
import { RoomSession } from './orchestrator'
import { OmpAgentRunner } from './runner'
import { saveRoom } from './save'

/** Streaming replies change a room many times a second; the renderer gets one room per burst. */
const EMIT_MS = 50
const JOURNAL_TIMEOUT_MS = 15_000

class NotFound extends Error {
  code = 'not-found'
}

/**
 * `rooms.*`: live rooms this app session runs, each a set of throwaway omp processes. A room's
 * record is the file it saves on resolve; nothing is persisted otherwise.
 */
export function registerRoomsIpc(ctx: MainContext): void {
  const { evaRoot, ompBin, live } = ctx.env
  // Read-only seats look at real code: the app's own checkout when the Eva root has it.
  const repo = path.join(evaRoot, 'work', 'evaos-electron')
  const toolsCwd = fs.existsSync(repo) ? repo : evaRoot
  const runner = new OmpAgentRunner({ ompBin, live, cwd: evaRoot, toolsCwd })
  const sessions = new Map<string, RoomSession>()
  const order: string[] = []
  const pending = new Map<string, NodeJS.Timeout>()

  const onChange = (room: Room): void => {
    if (pending.has(room.id)) return
    pending.set(
      room.id,
      setTimeout(() => {
        pending.delete(room.id)
        emit(ctx, 'rooms.changed', { room })
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

  const session = (roomId: string): RoomSession => {
    const s = sessions.get(roomId)
    if (!s) throw new NotFound(`No room ${roomId}`)
    return s
  }

  /** The roster entries asked for; a model missing from omp's catalog fails that agent early. */
  const agentsFor = async (agentIds: string[]): Promise<RoomAgent[]> => {
    const people = agentIds.map((id) => roomPerson(id)).filter((a): a is RoomAgent => a !== null)
    if (people.length === 0) throw new Error('No known agent was picked.')
    const known = await catalogFor(ctx)
      .list()
      .then((models) => new Set(models.map((m) => `${m.provider}/${m.id}`)))
      .catch(() => null)
    if (known === null) return people
    return people.map((a) => (known.has(a.model) ? a : { ...a, failed: true }))
  }

  handle(ctx, 'rooms.create', async ({ prompt, agentIds }) => {
    const agents = await agentsFor(agentIds)
    const s = new RoomSession(prompt, agents, {
      runner,
      judgeModel: ROOM_JUDGE_MODEL,
      save: (room) => saveRoom(room, { evaRoot, evaFs: evaFsFor(ctx), journal }),
      onChange,
      log: (line) => console.info(`[rooms] ${line}`),
    })
    sessions.set(s.room.id, s)
    order.unshift(s.room.id)
    onChange(s.room)
    void s.start()
    return { roomId: s.room.id }
  })
  handle(ctx, 'rooms.post', ({ roomId, text }) => {
    session(roomId).post(text)
    return { posted: true as const }
  })
  handle(ctx, 'rooms.react', ({ roomId, messageId, emoji }) => {
    session(roomId).react(messageId, emoji)
    return { reacted: true as const }
  })
  handle(ctx, 'rooms.stop', async ({ roomId }) => {
    await session(roomId).stop()
    return { stopped: true as const }
  })
  handle(ctx, 'rooms.list', () => ({
    rooms: order.map((id) => sessions.get(id)!.room),
  }))

  // Rooms die with the app. What is guaranteed: on a normal quit this hook ends every process
  // (stdin EOF, then SIGTERM, then SIGKILL to its process group, so omp's tool children go too)
  // and waits for the exits (bounded, inside the 12 s quit cap). What is not: if main is hard
  // killed or crashes, no hook runs; the children's stdin pipe closes and omp exits on EOF when
  // idle (observed), but an omp mid-tool, or a tool child that outlives it, can linger until it
  // finishes. omp has no parent-death flag to pass, and pids are not persisted across launches.
  ctx.onBeforeQuit(async () => {
    for (const t of pending.values()) clearTimeout(t)
    await Promise.allSettled([...sessions.values()].map((s) => s.destroy()))
  })
}
