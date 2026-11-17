// A thin client's own boards, moved once to the Mini: before this Mac read the host's boards it kept
// them in its own folder. The first time it is connected to a host that serves boards, the boards
// the host lacks go up (with the images their cards show from that folder), and the folder is
// renamed aside so this never runs again. Nothing is deleted.
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Board } from '@relay/canvas-live/board'
import { MAX_CANVAS_ASSET_BYTES } from '@relay/protocol'
import { isMissing, slugOf } from './board-files'
import { parseBoard } from './board-text'
import type { HostBoardFiles } from './host-board-files'

export interface BoardsMigration {
  /** Boards uploaded, by local slug and the slug they have on the host. */
  uploaded: Array<{ from: string; to: string }>
  /** Boards left out: the host has the same one, or the local one is empty. */
  skipped: string[]
  /** Image files uploaded. */
  assets: number
  /** Where the folder went; null when there was nothing to move (no folder, or no boards in it). */
  movedTo: string | null
}

/** No cards and no comments on any page. */
function isEmpty(board: Board): boolean {
  if (board.nodes.length > 0 || (board.threads?.length ?? 0) > 0) return false
  return (board.pages ?? []).every(
    (p) => (p.nodes?.length ?? 0) === 0 && (p.threads?.length ?? 0) === 0,
  )
}

/** The relative `src` of every image card on every page. */
function imageSrcs(board: Board): string[] {
  const nodes = [...board.nodes, ...(board.pages ?? []).flatMap((p) => p.nodes ?? [])]
  const srcs = new Set<string>()
  for (const n of nodes) {
    const src = n.data?.src
    if (n.type !== 'image' || src === undefined || src === '') continue
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || path.isAbsolute(src)) continue
    srcs.add(src)
  }
  return [...srcs]
}

/** `slug` with `suffix`, cut so the whole stays a board name (80 characters at most). */
function suffixed(slug: string, suffix: string): string {
  return `${slug.slice(0, 80 - suffix.length - 1).replace(/-+$/, '')}-${suffix}`
}

/** `2026-11-17`, local time. */
function dateStamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Uploads the boards in `dir` the host lacks, then renames `dir` to `<dir>.migrated-<date>`.
 * A board whose name the host has already is skipped when it is the same or empty here, else goes
 * up as `<slug>-<this Mac's short name>` (the first free one; one already uploaded the same is not
 * sent twice). Throws (leaving the folder where it is, for the next connect) when the host refuses
 * a board.
 */
export async function migrateLocalBoards(opts: {
  dir: string
  host: Pick<HostBoardFiles, 'list' | 'write' | 'writeAsset'>
  hostname: string
  today: Date
  log: (line: string) => void
}): Promise<BoardsMigration> {
  const { dir, host, log } = opts
  const result: BoardsMigration = { uploaded: [], skipped: [], assets: 0, movedTo: null }
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch (e) {
    if (isMissing(e)) return result
    throw e
  }
  const slugs = names
    .map((n) => slugOf(n))
    .filter((s): s is string => s !== null)
    .sort()
  if (slugs.length === 0) return result

  const theirs = new Map((await host.list()).map((e) => [e.slug, e.text]))
  const mac =
    (opts.hostname.split('.')[0] ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'mac'
  const sentAssets = new Set<string>()
  const root = path.resolve(dir)

  for (const slug of slugs) {
    let text: string
    try {
      text = await fs.promises.readFile(path.join(dir, `${slug}.json`), 'utf8')
    } catch {
      continue
    }
    let board: Board | null
    try {
      board = parseBoard(text)
    } catch {
      board = null
    }
    let target: string | null = slug
    if (theirs.has(slug)) {
      if (theirs.get(slug) === text || (board !== null && isEmpty(board))) {
        target = null
      } else {
        const base = suffixed(slug, mac)
        for (let n = 1; ; n++) {
          const name = n === 1 ? base : suffixed(base, String(n))
          const there = theirs.get(name)
          if (there === undefined) {
            target = name
            break
          }
          if (there === text) {
            target = null
            break
          }
        }
      }
    }
    if (target === null) {
      result.skipped.push(slug)
      continue
    }
    for (const src of board === null ? [] : imageSrcs(board)) {
      if (sentAssets.has(src)) continue
      const abs = path.resolve(root, src)
      if (!abs.startsWith(root + path.sep)) continue
      let bytes: Buffer
      try {
        const info = await fs.promises.stat(abs)
        if (!info.isFile()) continue
        if (info.size > MAX_CANVAS_ASSET_BYTES) {
          log(`[canvas-migrate] left ${src} behind: larger than 12 MB`)
          continue
        }
        bytes = await fs.promises.readFile(abs)
      } catch {
        continue
      }
      await host.writeAsset(path.relative(root, abs).split(path.sep).join('/'), bytes)
      sentAssets.add(src)
      result.assets += 1
    }
    await host.write(target, text, () => undefined)
    theirs.set(target, text)
    result.uploaded.push({ from: slug, to: target })
  }

  const base = `${dir}.migrated-${dateStamp(opts.today)}`
  let movedTo = base
  for (let n = 2; fs.existsSync(movedTo); n++) movedTo = `${base}-${n}`
  await fs.promises.rename(dir, movedTo)
  result.movedTo = movedTo
  for (const u of result.uploaded) {
    log(`[canvas-migrate] uploaded ${u.from}${u.to === u.from ? '' : ` as ${u.to}`} to the host`)
  }
  if (result.skipped.length > 0) {
    log(`[canvas-migrate] the host has these already: ${result.skipped.join(', ')}`)
  }
  log(`[canvas-migrate] ${result.assets} image(s) uploaded; local boards kept at ${movedTo}`)
  return result
}
