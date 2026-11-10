import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { FeedItemSchema, type FeedAction } from '@evaos/contract'
import type { MainContext } from '../context'
import { handle } from '../ipc/handle'
import { buildCommand, childPathFor, spawnDetached } from './spawn'

const FEED_DIR = 'work/discovery-feed'

/** feed.json is written by work/discovery-feed/fetch.ts; signals.jsonl is the append-only like/skip/save log it ranks with. */
export function feedList(root: string) {
  const dir = path.join(root, FEED_DIR)
  let generatedAt: string | null = null
  let rawItems: unknown[] = []
  let sources: Record<string, { ok: boolean; count?: number; error?: string; disabled?: boolean }> = {}
  try {
    const feed = JSON.parse(fs.readFileSync(path.join(dir, 'feed.json'), 'utf8')) as {
      generatedAt?: string
      items?: unknown[]
      sources?: typeof sources
    }
    generatedAt = feed.generatedAt ?? null
    rawItems = feed.items ?? []
    sources = feed.sources ?? {}
  } catch {
    // No feed yet: the page shows its empty state.
  }
  // `local:media/<file>` thumbnails (cached by the container from hosts blocked on Isaac's devices) go out as data URIs.
  const inline = (image: string | undefined): string | undefined => {
    if (!image?.startsWith('local:media/')) return image
    try {
      const file = path.join(dir, 'media', path.basename(image))
      if (fs.statSync(file).size > 1_000_000) return undefined
      const mime = file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
      return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
    } catch {
      return undefined
    }
  }
  const items = rawItems.flatMap((i) => {
    const p = FeedItemSchema.safeParse(i)
    return p.success ? [{ ...p.data, image: inline(p.data.image) }] : []
  })
  const acted: Record<string, FeedAction> = {}
  try {
    for (const line of fs.readFileSync(path.join(dir, 'signals.jsonl'), 'utf8').split('\n')) {
      if (!line) continue
      const s = JSON.parse(line) as { id?: string; action?: FeedAction }
      if (s.id && s.action) acted[s.id] = s.action
    }
  } catch {
    // No signals yet.
  }
  return { generatedAt, sources, items, acted }
}

export function feedSignal(
  root: string,
  s: { id: string; action: FeedAction; title: string; source: string },
): { recorded: true } {
  const dir = path.join(root, FEED_DIR)
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(path.join(dir, 'signals.jsonl'), JSON.stringify({ ...s, ts: Date.now() }) + '\n')
  return { recorded: true }
}

export function registerFeedIpc(ctx: MainContext): void {
  const root = ctx.env.evaRoot
  handle(ctx, 'feed.list', () => feedList(root))
  handle(ctx, 'feed.signal', (input) => feedSignal(root, input))
  handle(ctx, 'feed.refresh', async () => {
    const homedir = os.homedir()
    const cmd = buildCommand(path.join(root, FEED_DIR, 'fetch.ts'), [], {
      pathEnv: await childPathFor(false, homedir),
      homedir,
      execPath: process.execPath,
      baseEnv: process.env,
    })
    await spawnDetached(cmd, root)
    return { started: true }
  })
}
