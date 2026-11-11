// A council room on disk: `<workdir>/room.json`, rewritten after every round (and debounced on
// every change), so a room outlives the app. Relay Desktop lists every room it finds there at
// launch; a paused, wrapped or failed one resumes at its next round with the same seats.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import {
  RoomCouncilInputSchema,
  RoomRenderSchema,
  RoomSchema,
  RoutingEntrySchema,
} from '@evaos/contract'

export const ROOM_STATE_FILE = 'room.json'
export const ROOM_STATE_VERSION = 1

/**
 * What a seat's harness needs to pick its session up again; saved with the room so a paused room
 * resumes every seat where it stopped.
 * - omp: the session file it writes under the room's `sessions/<seat>/`.
 * - Claude Code: the session id (`--resume <id>`; Claude Code keeps the transcript in its home).
 * - Codex: the thread (`codex exec resume <thread>`) and the thread's token totals so far, since
 *   `turn.completed` reports running totals and a resumed thread starts from them.
 */
export const SeatSessionSchema = z.discriminatedUnion('harness', [
  z.object({ harness: z.literal('omp'), file: z.string().min(1) }),
  z.object({ harness: z.literal('claude-code'), id: z.string().min(1) }),
  z.object({
    harness: z.literal('codex'),
    thread: z.string().min(1),
    totals: z.object({ input: z.number(), cached: z.number(), output: z.number() }),
  }),
])
export type SeatSession = z.infer<typeof SeatSessionSchema>

const Renders = z.array(RoomRenderSchema)

export const CouncilStateSchema = z.object({
  version: z.literal(ROOM_STATE_VERSION),
  room: RoomSchema,
  /** What the room was started with (source, refs, render command, rubric, routing). */
  input: RoomCouncilInputSchema,
  /** `memory/rooms/<stem>`: the record and routing log keep it across resumes. */
  stem: z.string(),
  /** How far the run got: the brief and the contract (or plan) are done, and the next round to run. */
  progress: z.object({ briefed: z.boolean(), planned: z.boolean(), nextRound: z.number().int().min(1) }),
  /** Per seat: the highest message number it has been shown, and its harness session. */
  seats: z.record(
    z.string(),
    z.object({ seen: z.number(), session: SeatSessionSchema.optional() }),
  ),
  /** Isaac's posts up to this message number have been answered. */
  isaacSeen: z.number(),
  renders: z.object({
    full: Renders,
    before: Renders,
    paintover: Renders,
    parts: z.record(z.string(), Renders),
  }),
  fixes: z.record(z.string(), z.array(z.string())),
  bounces: z.record(z.string(), z.string()),
  plateauStreak: z.number(),
  routing: z.array(RoutingEntrySchema),
})
export type CouncilState = z.infer<typeof CouncilStateSchema>

/** Writes the state whole (temp file, then rename), so a crash never leaves half a file. */
export function writeRoomState(workdir: string, state: CouncilState): void {
  const file = path.join(workdir, ROOM_STATE_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state))
  fs.renameSync(tmp, file)
}

/** Every room state under `roomsDir` (`<eva>/work/rooms`) that parses; the rest are logged and skipped. */
export function readRoomStates(roomsDir: string, log: (line: string) => void): CouncilState[] {
  let dirs: string[]
  try {
    dirs = fs.readdirSync(roomsDir)
  } catch {
    return []
  }
  const out: CouncilState[] = []
  for (const d of dirs) {
    const file = path.join(roomsDir, d, ROOM_STATE_FILE)
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      continue // a room from before rooms were saved, or not a room
    }
    try {
      const parsed = CouncilStateSchema.safeParse(JSON.parse(raw))
      if (parsed.success) out.push(parsed.data)
      else log(`${file}: not a room state (${parsed.error.issues[0]?.message ?? 'invalid'})`)
    } catch (e) {
      log(`${file}: unreadable (${e instanceof Error ? e.message : String(e)})`)
    }
  }
  return out
}
