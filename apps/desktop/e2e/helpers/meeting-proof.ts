import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { APP_DIR } from './paths'

type Json = Record<string, unknown>
const JsonSchema = z.record(z.string(), z.unknown())
/** The host's `moments.json`, or a bare list of moments. */
const MomentsFile = z.union([
  z.object({ moments: z.array(JsonSchema) }).transform((f) => f.moments),
  z.array(JsonSchema),
])

/**
 * A recording's key moments and screen snapshots for the Meeting tab e2e, read from a folder laid
 * out like the Relay Host's recording dir (apps/linux src/meetings/store.ts): `moments.json`
 * (`{moments, through}`), `shots.jsonl` (one row per shot: n, atMs, w, h, hash, ocr, line; a null
 * row is a shot that was not kept), `shots/<n>.jpg`, and optionally `lines.jsonl` (the transcript,
 * the last copy of a line id wins). `MEETING_PROOF_DIR` points it at a real replay's output
 * (proof/meeting-moments/run.ts writes one outside the repo: real calls never get committed);
 * without it the synthetic `e2e/fixtures/meeting-proof` is used.
 */
export const MEETING_PROOF_DIR =
  process.env['MEETING_PROOF_DIR'] ?? path.join(APP_DIR, 'e2e/fixtures/meeting-proof')

export interface MeetingProof {
  /** The transcript, or null when the folder has none. */
  lines: Json[] | null
  moments: Json[]
  /** As the host serves them: each with its `src` path. */
  shots: Json[]
  /** JPEG bytes by `src` path. */
  files: Map<string, Buffer>
}

const jsonl = (file: string): Json[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JsonSchema.nullable().parse(JSON.parse(l)))
        .filter((r) => r !== null)
    : []

/** Loads the folder for recording `id`; shot paths use `token` like the host's. */
export function loadMeetingProof(
  id: string,
  token = 'proof',
  dir = MEETING_PROOF_DIR,
): MeetingProof {
  const momentsFile = path.join(dir, 'moments.json')
  const moments = fs.existsSync(momentsFile)
    ? MomentsFile.parse(JSON.parse(fs.readFileSync(momentsFile, 'utf8')))
    : []
  const files = new Map<string, Buffer>()
  const shots = jsonl(path.join(dir, 'shots.jsonl')).map(({ hash: _hash, ...row }) => {
    const src = `/meetings/shots/${id}/${token}/${String(row.n)}`
    files.set(src, fs.readFileSync(path.join(dir, 'shots', `${String(row.n)}.jpg`)))
    return { ...row, src }
  })
  const linesFile = path.join(dir, 'lines.jsonl')
  let lines: Json[] | null = null
  if (fs.existsSync(linesFile)) {
    const byId = new Map<string, Json>()
    for (const l of jsonl(linesFile)) byId.set(String(l.id), l)
    lines = [...byId.values()].sort((a, b) => Number(a.startMs) - Number(b.startMs))
  }
  return { lines, moments, shots, files }
}
