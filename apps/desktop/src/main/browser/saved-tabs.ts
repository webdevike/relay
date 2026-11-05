import { loadableUrl } from '@evaos/browser-core/address'
import { SwitchAppIdSchema } from '@evaos/contract'
import type { ConfigStore } from '../config-store'

/**
 * The browser panel's tabs as they survive a restart: every non-blank tab with its owning scope
 * (a chat, a page, or pinned), URL, title and favicon in creation order, plus the active tab each
 * scope had. Restored tabs start dormant; a scope's active tab loads when the scope is shown.
 */
export const SAVED_TABS_FILE = 'browser-tabs.json'

/** Dormant tabs cost no process, so more are kept than MAX_TABS live views; oldest drop first. */
export const MAX_SAVED_TABS = 200

const SAVE_MS = 400

export interface SavedTab {
  id: string
  /** The owning scope; PINNED_SCOPE for a pinned tab. */
  scope: string
  url: string
  title: string
  favicon: string | null
  /** Opened by the extension host: its `chrome-extension:` page may reload. */
  fromExtension?: true
  /** The local eCard app this tab shows through the app switch (its own `ecard_app`). */
  switchApp?: string
  /** Who opened the tab (TabState.openedBy). */
  openedBy?: string
}

export interface SavedBrowserTabs {
  tabs: SavedTab[]
  /** Scope to the tab it had active. */
  active: Record<string, string>
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Validates browser-tabs.json; anything unusable is dropped, never thrown. */
export function parseSavedTabs(raw: unknown): SavedBrowserTabs {
  const out: SavedBrowserTabs = { tabs: [], active: {} }
  if (!isObject(raw) || !Array.isArray(raw.tabs)) return out
  const seen = new Set<string>()
  for (const r of raw.tabs) {
    if (!isObject(r)) continue
    const { id, scope, url } = r
    if (typeof id !== 'string' || !/^t\d+$/.test(id) || seen.has(id)) continue
    if (typeof scope !== 'string' || scope === '' || scope.length > 1024) continue
    const fromExtension = r.fromExtension === true
    const switchApp = SwitchAppIdSchema.safeParse(r.switchApp).data
    const openedBy =
      typeof r.openedBy === 'string' && r.openedBy.length <= 120 ? r.openedBy : undefined
    if (typeof url !== 'string' || !loadableUrl(url, { fromExtension })) continue
    seen.add(id)
    out.tabs.push({
      id,
      scope,
      url,
      title: typeof r.title === 'string' ? r.title : '',
      favicon: typeof r.favicon === 'string' ? r.favicon : null,
      ...(fromExtension ? { fromExtension: true as const } : {}),
      ...(switchApp ? { switchApp } : {}),
      ...(openedBy ? { openedBy } : {}),
    })
  }
  out.tabs = out.tabs.slice(-MAX_SAVED_TABS)
  const kept = new Set(out.tabs.map((t) => t.id))
  if (isObject(raw.active)) {
    for (const [scope, id] of Object.entries(raw.active)) {
      if (typeof id === 'string' && kept.has(id)) out.active[scope] = id
    }
  }
  return out
}

/** Reads the saved tabs once and writes the current ones shortly after each change (atomic). */
export class SavedTabsStore {
  private timer: NodeJS.Timeout | null = null
  private closed = false

  constructor(
    private readonly config: ConfigStore,
    private readonly current: () => SavedBrowserTabs,
  ) {}

  load(): SavedBrowserTabs {
    return parseSavedTabs(this.config.readJson<unknown>(SAVED_TABS_FILE, null))
  }

  dirty(): void {
    if (this.closed || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, SAVE_MS)
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.closed) return
    try {
      this.config.writeJson(SAVED_TABS_FILE, this.current())
    } catch (e) {
      console.warn('[browser] saving tabs failed:', e instanceof Error ? e.message : e)
    }
  }

  /** Last write; later changes (views torn down at quit) are not saved. */
  close(): void {
    this.flush()
    this.closed = true
  }
}
