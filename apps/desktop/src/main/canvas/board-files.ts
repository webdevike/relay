import * as fs from 'node:fs'
import * as path from 'node:path'
import { boardRevision, writeBoardFile } from '@relay/canvas-live/board-file'

/** One board as `list` finds it. */
export interface BoardFileEntry {
  slug: string
  text: string
  modifiedMs: number
}

/**
 * Where the board store reads and writes its `<slug>.json` files: the boards folder on this Mac
 * (localBoardFiles), or the Relay Host's folder on a thin client (host-board-files.ts). Slugs are
 * checked by the store before they get here.
 */
export interface BoardFiles {
  /** A board's text, null when there is none. */
  read(slug: string): Promise<string | null>
  /**
   * Replaces a board's text atomically. `commit` runs right before the new text lands and throws
   * to write nothing. With `base` (the text the writer read; null: there was no board) it lands
   * only while the board is still `base`, else it throws `conflict` and writes nothing: another
   * writer (the host for another Mac, the Mini's own desktop) changed it since.
   */
  write(slug: string, text: string, commit: () => void, base?: string | null): Promise<void>
  /** Every board (unreadable ones left out); a missing folder has none. */
  list(): Promise<BoardFileEntry[]>
  /** Deletes a board; one that is not there is fine. */
  remove(slug: string): Promise<void>
  exists(slug: string): Promise<boolean>
  /** Appends `line` to the board's `<slug>.history.jsonl`. */
  appendHistory(slug: string, line: string): Promise<void>
}

/** `<slug>.json` in the boards folder; temp files and other names are not boards. */
export function slugOf(file: string): string | null {
  const m = /^([a-z0-9-]{1,80})\.json$/.exec(path.basename(file))
  return m ? m[1]! : null
}

export function isMissing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** The boards folder `dir` on this Mac. */
export function localBoardFiles(dir: string): BoardFiles {
  const file = (slug: string): string => path.join(dir, `${slug}.json`)
  return {
    async read(slug) {
      try {
        return await fs.promises.readFile(file(slug), 'utf8')
      } catch (e) {
        if (isMissing(e)) return null
        throw e
      }
    },
    async write(slug, text, commit, base) {
      await writeBoardFile(file(slug), text, {
        commit,
        ifRevision: base === undefined ? undefined : boardRevision(base),
      })
    },
    async list() {
      let names: string[]
      try {
        names = await fs.promises.readdir(dir)
      } catch (e) {
        if (isMissing(e)) return []
        throw e
      }
      const entries: BoardFileEntry[] = []
      for (const name of names) {
        const slug = slugOf(name)
        if (!slug) continue
        try {
          const abs = path.join(dir, name)
          const modifiedMs = (await fs.promises.stat(abs)).mtimeMs
          const text = await fs.promises.readFile(abs, 'utf8')
          entries.push({ slug, text, modifiedMs })
        } catch {
          continue
        }
      }
      return entries
    },
    async remove(slug) {
      try {
        await fs.promises.unlink(file(slug))
      } catch (e) {
        if (!isMissing(e)) throw e
      }
    },
    async exists(slug) {
      return fs.existsSync(file(slug))
    },
    async appendHistory(slug, line) {
      await fs.promises.appendFile(path.join(dir, `${slug}.history.jsonl`), line)
    },
  }
}
