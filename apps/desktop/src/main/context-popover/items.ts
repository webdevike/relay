// Work items for the context popover: the frontmatter of every ledger under `<eva>/work/items`
// (stage, whose move, next step, PR). Read only; each file is parsed again only when it changes.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { frontmatter, joinPath, prFromUrl } from '@evaos/chat-core/work'

export interface Item {
  key: string
  file: string
  title: string | null
  stage: string | null
  /** Whose move it is, lower case (`isaac`, `eva`, `noah`). */
  move: string | null
  next: string | null
  /** The ledger's `linear:` ticket URL. */
  linear: string | null
  workspace: string | null
  pr: { repo: string; number: number; url: string } | null
  worktree: string | null
  branch: string | null
  /** `updated:` as epoch ms (local midnight), else the file's mtime. */
  updatedMs: number
}

/** Stages after which nothing waits on anyone (the dev cycle's last stage, and shipped). */
const FINISHED = /^(11\b|after merge|ship(ped)?\b|done\b|closed\b|merged\b)/i

/** Whether the item's work is over: nothing waits on Isaac (no Needs input, no Ready for review). */
export function itemFinished(item: Pick<Item, 'stage'>): boolean {
  return FINISHED.test(item.stage?.trim() ?? '')
}

/** Stages where the work is built and Isaac's move is to look at it: verify, PR, review. */
const REVIEW = /^((7|8|9|10)\b|verify|pr\b|review)/i

/** Whether Isaac's move on the item is reviewing what was built (Ready for review), not answering. */
export function itemReady(item: Pick<Item, 'stage'>): boolean {
  return REVIEW.test(item.stage?.trim() ?? '')
}

export function parseItem(stem: string, text: string, root: string, mtimeMs: number): Item {
  const f = frontmatter(text)
  const field = (name: string): string | null => {
    const v = f.get(name)?.trim()
    return v === undefined || v === '' ? null : v
  }
  const prUrl = field('pr')
  const pr = prUrl === null ? null : prFromUrl(prUrl)
  const updated = field('updated')
  const day = updated === null ? NaN : Date.parse(`${updated.slice(0, 10)}T00:00:00`)
  const title = field('title')
  const worktree = field('worktree')
  return {
    key: field('key') ?? stem,
    file: path.join(root, 'work/items', `${stem}.md`),
    title: title === null ? null : title.replace(/^\[[^\]]*\]\s*/, '').trim(),
    stage: field('stage'),
    move: field('move')?.toLowerCase() ?? null,
    next: field('next'),
    linear: field('linear'),
    workspace: field('workspace'),
    pr: pr === null ? null : { ...pr, url: `https://github.com/${pr.repo}/pull/${pr.number}` },
    worktree: worktree === null ? null : joinPath(root, worktree),
    branch: field('branch'),
    updatedMs: Number.isNaN(day) ? mtimeMs : day,
  }
}

/**
 * Every ledger (`<key>.md`; companions like `ENG-1.pr.md` and the generated `_index.md` are not
 * ledgers), cached by mtime and size.
 */
export class ItemReader {
  private readonly seen = new Map<string, { mtimeMs: number; size: number; item: Item }>()

  constructor(private readonly root: string) {}

  all(): Item[] {
    const dir = path.join(this.root, 'work/items')
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      this.seen.clear()
      return []
    }
    const out: Item[] = []
    const present = new Set<string>()
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      const stem = name.slice(0, -3)
      if (stem === '' || stem.includes('.') || stem.startsWith('_')) continue
      const file = path.join(dir, name)
      let st: fs.Stats
      try {
        st = fs.statSync(file)
      } catch {
        continue
      }
      if (!st.isFile()) continue
      present.add(file)
      let hit = this.seen.get(file)
      if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
        let text: string
        try {
          text = fs.readFileSync(file, 'utf8')
        } catch {
          continue
        }
        hit = {
          mtimeMs: st.mtimeMs,
          size: st.size,
          item: parseItem(stem, text, this.root, st.mtimeMs),
        }
        this.seen.set(file, hit)
      }
      out.push(hit.item)
    }
    for (const f of [...this.seen.keys()]) if (!present.has(f)) this.seen.delete(f)
    return out
  }

  byKey(key: string): Item | null {
    return this.all().find((i) => i.key === key) ?? null
  }
}
