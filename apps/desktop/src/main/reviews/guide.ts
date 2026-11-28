// The Reviews Guide: a reviewer's walkthrough of a PR, written by Claude headless (`claude -p`, no
// tools, no session) from the PR's title, body and annotated diff. The prompt and the check of the
// answer are `@relay/protocol/review-guide`, shared with the Relay Host's runner, so local mode and
// a host write the same Guide; when the model fails the files are grouped by folder instead. Kept
// per PR base and head commit in the config dir, so a PR is written once per push (or base move).
import * as os from 'node:os'
import { z } from 'zod'
import { ReviewGuideSchema, type ReviewGuide } from '@evaos/contract'
import {
  folderSections,
  guideRequest,
  NO_TEXT_CHANGES,
  parseGuide,
  type GuideInput,
} from '@relay/protocol/review-guide'
import type { ConfigStore } from '../config-store'
import { buildCommand, childPathFor, runCapture } from '../eva/spawn'

export const GUIDES_FILE = 'reviews-guides.json'
const GUIDE_TIMEOUT_MS = 180_000
const KEEP_GUIDES = 40
/** Cache generation: entries of earlier generations (head-only keys, unchecked prose) are not served. */
const CACHE_VERSION = 'v3'
export const HEAD_CHANGED = 'PR changed; regenerating'

const ClaudeOut = z.object({ result: z.string(), is_error: z.boolean().optional() })
const Saved = z.record(z.string(), ReviewGuideSchema.extend({ at: z.number() }))

/** What the Guide is written from, read at one base and head commit (`base...head`). */
export type GuideSnapshot = GuideInput & { headRefOid: string; baseRefOid: string }

/** The commits the renderer shows; a snapshot read at others is refused. */
export interface GuidePin {
  headSha: string
  /** Absent from older hosts' PRs: then only the head is checked. */
  baseSha?: string | undefined
}

/** Runs the prompt once and answers the model's text; throws with a short reason. */
export type GuideWriter = (prompt: string) => Promise<string>

/** `claude -p` on Sonnet with no tools, no MCP servers, no settings and no saved session; the prompt goes on stdin. */
export function claudeWriter(claudeBin: string, live: boolean): GuideWriter {
  const home = os.homedir()
  let pathEnv: Promise<string> | null = null
  return async (prompt) => {
    pathEnv ??= childPathFor(live, home)
    const cmd = buildCommand(
      claudeBin,
      [
        '-p',
        '--model',
        'sonnet',
        '--tools',
        '',
        '--output-format',
        'json',
        '--no-session-persistence',
        '--strict-mcp-config',
        '--setting-sources',
        '',
      ],
      { pathEnv: await pathEnv, homedir: home, execPath: process.execPath, baseEnv: process.env },
    )
    const res = await runCapture(cmd, os.tmpdir(), GUIDE_TIMEOUT_MS, prompt)
    if (res.timedOut) throw new Error('Claude took too long')
    if (res.code !== 0) throw new Error(`claude exited ${res.code ?? 'by a signal'}`)
    let json: unknown
    try {
      json = JSON.parse(res.stdout)
    } catch {
      throw new Error('Claude returned no answer')
    }
    const out = ClaudeOut.safeParse(json)
    if (!out.success || out.data.is_error) throw new Error('Claude returned no answer')
    return out.data.result
  }
}

/** The Guide for `pin`; rejects with HEAD_CHANGED when the snapshot was read at other commits. */
export type GuideRead = (key: string, pin: GuidePin, pr: GuideSnapshot) => Promise<ReviewGuide>

/** Writes one Guide: the model's walkthrough, or the folder fallback with the reason (the model is not asked without text changes). */
async function writeGuide(
  write: GuideWriter,
  headSha: string,
  pr: GuideInput,
): Promise<ReviewGuide> {
  const paths = pr.files.map((f) => f.path)
  try {
    const req = guideRequest(pr)
    if (!req) throw new Error(NO_TEXT_CHANGES)
    const body = parseGuide(await write(req.prompt), req.sent, paths)
    if (!body) throw new Error('Claude answered in the wrong shape')
    return { headSha, source: 'model', error: null, ...body }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    return { headSha, source: 'folders', error, sections: folderSections(paths) }
  }
}

/** One Guide per PR base and head, kept in the config dir; one generation at a time per pair. */
export function guideCache(config: ConfigStore, write: GuideWriter): GuideRead {
  const running = new Map<string, Promise<ReviewGuide>>()
  const saved = (): z.infer<typeof Saved> => {
    const all = Saved.safeParse(config.readJson<unknown>(GUIDES_FILE, {}))
    return all.success ? all.data : {}
  }
  const keep = (id: string, guide: ReviewGuide): void => {
    const kept = Object.entries({ ...saved(), [id]: { ...guide, at: Date.now() } })
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, KEEP_GUIDES)
    config.writeJson(GUIDES_FILE, Object.fromEntries(kept))
  }
  return (key, pin, pr) => {
    const moved = pr.headRefOid !== pin.headSha || (pin.baseSha && pr.baseRefOid !== pin.baseSha)
    if (moved) return Promise.reject(new Error(HEAD_CHANGED))
    const id = `${key}@${pr.baseRefOid}...${pr.headRefOid}@${CACHE_VERSION}`
    const hit = saved()[id]
    if (hit) return Promise.resolve(ReviewGuideSchema.parse(hit))
    const busy = running.get(id)
    if (busy) return busy
    const job = writeGuide(write, pr.headRefOid, pr)
      .then((guide) => {
        // Only a written Guide is kept; after a fallback the next open asks the model again.
        if (guide.source === 'model') keep(id, guide)
        return guide
      })
      .finally(() => running.delete(id))
    running.set(id, job)
    return job
  }
}
