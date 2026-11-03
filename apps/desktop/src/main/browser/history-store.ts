import { addVisit, makeVisit, suggest, type Visit } from '@evaos/browser-core/history'
import type { ConfigStore } from '../config-store'

const FILE = 'browser-history.json'
const MAX = 2000
const FLUSH_MS = 500

/**
 * In-app browsing history, stored as JSON in the config dir through ConfigStore (atomic). JSON
 * over node:sqlite: tiny data, no experimental surface (D-11 discretion).
 */
export class HistoryStore {
  private list: Visit[]
  private timer: NodeJS.Timeout | null = null
  /** Titles seen before the load counted, folded the way history.rs does it. */
  private counted = new Set<string>()

  constructor(private readonly config: ConfigStore) {
    const raw = config.readJson<unknown>(FILE, [])
    this.list = []
    if (Array.isArray(raw)) {
      for (const r of raw as Array<Record<string, unknown>>) {
        if (typeof r?.url === 'string') {
          addVisit(
            this.list,
            makeVisit(
              r.url,
              typeof r.title === 'string' ? r.title : '',
              typeof r.visits === 'number' ? r.visits : 1,
            ),
          )
        }
      }
    }
  }

  /** A page finished navigating (counts one visit per navigation id). */
  visit(url: string, title: string): void {
    if (!/^https?:/.test(url)) return
    addVisit(this.list, makeVisit(url, title, 1))
    this.dirty()
  }

  /** The title arrived: update the entry without counting a visit. */
  title(url: string, title: string): void {
    if (!/^https?:/.test(url) || !title) return
    addVisit(this.list, makeVisit(url, title, 0))
    this.dirty()
  }

  suggest(text: string): Array<{ url: string; title: string }> {
    return suggest(this.list, text, 6).map((v) => ({ url: v.url, title: v.title }))
  }

  private dirty(): void {
    if (this.list.length > MAX) {
      this.list.sort((a, b) => b.visits - a.visits)
      this.list.length = MAX
    }
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, FLUSH_MS)
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.config.writeJson(
      FILE,
      this.list.map(({ url, title, visits }) => ({ url, title, visits })),
    )
  }
}
