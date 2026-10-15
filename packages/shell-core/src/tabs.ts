/**
 * Immutable tab reducer, ported from the Rust app's tabs.rs.
 *
 * Differences from Rust: navigation is explicit (`navigate(tabs, place)` replaces the
 * pending/commit pair), operations take stable tab ids, and closing the last tab leaves a
 * Dashboard tab (decision D-07) where Rust opens a new chat.
 */
import {
  placeEquals,
  placeFromJson,
  placeOf,
  placeToJson,
  samePlace,
  type Place,
  type PlaceJson,
} from './place'

export const HISTORY = 50

export interface Tab {
  id: number
  here: Place
  back: Place[]
  forward: Place[]
  pinned: boolean
}

export interface Tabs {
  list: Tab[]
  active: number
  nextId: number
  /** A cmd-click fork just opened the active tab; its first navigation starts no history. */
  fresh: boolean
}

export interface SavedTabs {
  active: number
  list: Array<{ here: PlaceJson; back: PlaceJson[]; forward: PlaceJson[]; pinned: boolean }>
}

export function createTabs(list: Tab[], active: number): Tabs {
  const nextId = list.reduce((max, tab) => Math.max(max, tab.id + 1), 0)
  const clamped = Math.max(0, Math.min(active, list.length - 1))
  const activeId = list[clamped]?.id
  // Stable sort: pinned tabs first, whatever order they were saved in.
  const sorted = [...list.filter((t) => t.pinned), ...list.filter((t) => !t.pinned)]
  const ix = sorted.findIndex((t) => t.id === activeId)
  return { list: sorted, active: ix < 0 ? 0 : ix, nextId, fresh: false }
}

function newTab(tabs: Tabs, here: Place): [Tab, number] {
  return [{ id: tabs.nextId, here, back: [], forward: [], pinned: false }, tabs.nextId + 1]
}

export function defaultTabs(): Tabs {
  const empty: Tabs = { list: [], active: 0, nextId: 0, fresh: false }
  const [tab, nextId] = newTab(empty, placeOf('dashboard'))
  return { list: [tab], active: 0, nextId, fresh: false }
}

export function activeTab(tabs: Tabs): Tab {
  return tabs.list[tabs.active]
}

function capped(stack: Place[], place: Place): Place[] {
  const next = [...stack, place]
  return next.length > HISTORY ? next.slice(next.length - HISTORY) : next
}

function pinnedCount(tabs: Tabs): number {
  return tabs.list.filter((t) => t.pinned).length
}

/** Where a tab opened from the active one goes: right after it, never among the pinned. */
function nextSlot(tabs: Tabs): number {
  return Math.max(tabs.active + 1, pinnedCount(tabs))
}

function placesFrom(value: unknown): Place[] {
  if (!Array.isArray(value)) return []
  const out: Place[] = []
  for (const item of value) {
    const place = placeFromJson(item)
    if (place) out.push(place)
  }
  return out.length > HISTORY ? out.slice(out.length - HISTORY) : out
}

/** Never throws, whatever the saved value is. */
export function loadTabs(saved: unknown): Tabs {
  const root = typeof saved === 'object' && saved !== null ? (saved as Record<string, unknown>) : {}
  const list: Tab[] = []
  if (Array.isArray(root.list)) {
    root.list.forEach((raw, ix) => {
      if (typeof raw !== 'object' || raw === null) return
      const entry = raw as Record<string, unknown>
      const here = placeFromJson(entry.here)
      if (!here) return
      list.push({
        id: ix,
        here,
        back: placesFrom(entry.back),
        forward: placesFrom(entry.forward),
        pinned: entry.pinned === true,
      })
    })
  }
  if (list.length === 0) return defaultTabs()
  const active =
    typeof root.active === 'number' && Number.isFinite(root.active) && root.active >= 0
      ? Math.floor(root.active)
      : 0
  return createTabs(list, active)
}

export function saveTabs(tabs: Tabs): SavedTabs {
  return {
    active: tabs.active,
    list: tabs.list.map((t) => ({
      here: placeToJson(t.here),
      back: t.back.map(placeToJson),
      forward: t.forward.map(placeToJson),
      pinned: t.pinned,
    })),
  }
}

function withTab(tabs: Tabs, ix: number, patch: Partial<Tab>): Tab[] {
  return tabs.list.map((t, i) => (i === ix ? { ...t, ...patch } : t))
}

/** Main now shows `place`. See Rust `Tabs::arrive`. */
export function navigate(input: Tabs, place: Place): Tabs {
  const fresh = input.fresh
  const tabs: Tabs = { ...input, fresh: false }
  const active = tabs.active
  const from = activeTab(tabs).here
  const left = placeEquals(from, place) ? null : from
  if (fresh || left) {
    let open = -1
    for (let ix = 0; ix < tabs.list.length; ix++) {
      if (ix !== active && samePlace(tabs.list[ix].here, place)) {
        open = ix
        break
      }
    }
    if (open >= 0) {
      let list = withTab(tabs, open, { here: place })
      if (fresh) {
        list = list.filter((_, i) => i !== active)
        if (open > active) open -= 1
      } else if (left) {
        list = list.map((t, i) => (i === active ? { ...t, here: left } : t))
      }
      return { ...tabs, list, active: open }
    }
    if (left && activeTab(tabs).pinned) {
      const list = withTab(tabs, active, { here: left })
      const at = nextSlot(tabs)
      const [tab, nextId] = newTab(tabs, place)
      list.splice(at, 0, tab)
      return { ...tabs, list, active: at, nextId }
    }
  }
  const tab = activeTab(tabs)
  if (left) {
    return {
      ...tabs,
      list: withTab(tabs, active, {
        back: capped(tab.back, left),
        forward: [],
        here: place,
      }),
    }
  }
  if (!placeEquals(tab.here, place))
    return { ...tabs, list: withTab(tabs, active, { here: place }) }
  return tabs
}

/** cmd-click: copy the current place into a new tab after the active one. */
export function forkTab(tabs: Tabs): Tabs {
  const [tab, nextId] = newTab(tabs, activeTab(tabs).here)
  const at = nextSlot(tabs)
  const list = [...tabs.list]
  list.splice(at, 0, tab)
  return { list, active: at, nextId, fresh: true }
}

/** Plus button and cmd+T: a draft chat at the end. */
export function openNewChat(tabs: Tabs): Tabs {
  const [tab, nextId] = newTab(tabs, placeOf('chat'))
  return { list: [...tabs.list, tab], active: tabs.list.length, nextId, fresh: false }
}

export function switchTo(tabs: Tabs, id: number): Tabs {
  const ix = tabs.list.findIndex((t) => t.id === id)
  if (ix < 0) return tabs
  return { ...tabs, active: ix, fresh: false }
}

export function closeTab(tabs: Tabs, id: number): Tabs {
  const ix = tabs.list.findIndex((t) => t.id === id)
  if (ix < 0) return tabs
  const list = tabs.list.filter((_, i) => i !== ix)
  if (list.length === 0) {
    // Rust opens a new chat here; decision D-07 locks a Dashboard tab instead.
    const [tab, nextId] = newTab(tabs, placeOf('dashboard'))
    return { list: [tab], active: 0, nextId, fresh: false }
  }
  let active = tabs.active
  if (ix < active) active -= 1
  else if (ix === active) active = Math.min(ix, list.length - 1)
  return { ...tabs, list, active, fresh: false }
}

export function closeActive(tabs: Tabs): Tabs {
  const tab = activeTab(tabs)
  return tab.pinned ? tabs : closeTab(tabs, tab.id)
}

export function closeOthers(tabs: Tabs, id: number): Tabs {
  if (!tabs.list.some((t) => t.id === id)) return tabs
  const list = tabs.list.filter((t) => t.pinned || t.id === id)
  return { ...tabs, list, active: list.findIndex((t) => t.id === id), fresh: false }
}

export function togglePin(tabs: Tabs, id: number): Tabs {
  const ix = tabs.list.findIndex((t) => t.id === id)
  if (ix < 0) return tabs
  const activeId = activeTab(tabs).id
  const tab = { ...tabs.list[ix], pinned: !tabs.list[ix].pinned }
  const rest = tabs.list.filter((_, i) => i !== ix)
  const at = rest.filter((t) => t.pinned).length
  rest.splice(at, 0, tab)
  return { ...tabs, list: rest, active: rest.findIndex((t) => t.id === activeId) }
}

function step(tabs: Tabs, goBack: boolean): Tabs {
  const tab = activeTab(tabs)
  const source = goBack ? tab.back : tab.forward
  if (source.length === 0) return tabs
  const target = source[source.length - 1]
  const remaining = source.slice(0, -1)
  const other = capped(goBack ? tab.forward : tab.back, tab.here)
  return {
    ...tabs,
    list: withTab(
      tabs,
      tabs.active,
      goBack
        ? { back: remaining, forward: other, here: target }
        : { forward: remaining, back: other, here: target },
    ),
  }
}

export function back(tabs: Tabs): Tabs {
  return step(tabs, true)
}

export function forward(tabs: Tabs): Tabs {
  return step(tabs, false)
}
