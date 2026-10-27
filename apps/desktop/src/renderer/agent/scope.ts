import { notifications } from '@mantine/notifications'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { ChatRow } from '@evaos/contract'
import { browserScope, pageFromKey, placeOf, type Place } from '@evaos/shell-core'
import { agentTitle } from '../eva/names-store'
import { listStore } from '../chat/list/list-store'
import { layoutStore } from '../shell/layout-store'
import { tabTitle } from '../tabs/tab-meta'
import { tabsStore } from '../tabs/tabs-store'
import { withFocusHold } from './focus-safety'

/**
 * Where an agent's panel action lands. Agents act in their own page (an assistant's page, the
 * chat they run in) even when Isaac is looking at another one: the change goes to that page's
 * panel without switching pages, and its tab shows a badge until he opens it.
 */
export interface ScopeTarget {
  /** The browser scope (`page:agent:nova`, `chat:<file>`), as browserScope names it. */
  scope: string
  /** The page's title, for the toast when no tab shows it. */
  title: string
  /** The chat file a chat scope shows (the Files panel's worktree); null for pages. */
  chatFile: string | null
  /** Who acted, as the badge names it: the agent of an agent page, else Eva. */
  actor: string
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

function pageTarget(scope: string, place: Place): ScopeTarget {
  const agent = place.page.startsWith('agent:') ? place.page.slice('agent:'.length) : null
  return {
    scope,
    title: tabTitle(place),
    chatFile: null,
    actor: agent === null ? 'Eva' : (agentTitle(agent) ?? agent),
  }
}

function chatTarget(file: string, title: string | null): ScopeTarget {
  const place = placeOf('chat', { chat: file })
  return {
    scope: browserScope(place, 0),
    title: title ?? tabTitle(place),
    chatFile: file,
    actor: 'Eva',
  }
}

/**
 * A scope as agents name it: a page key (`agent:nova`, `test-bench`, `workspace:<slug>`), a chat
 * session id or file (listed or not), or a browser scope (`page:…`, `chat:…`).
 */
export function resolveScope(input: string, rows: readonly ChatRow[]): ScopeTarget {
  const q = input.trim()
  if (q.startsWith('chat:') && q.length > 'chat:'.length) {
    const file = q.slice('chat:'.length)
    return chatTarget(file, rows.find((r) => r.file === file)?.title ?? null)
  }
  // A page key, or the browser scope of one (`page:agent:nova`, `page:canvas:<id>`).
  const name = q.startsWith('page:') ? q.slice('page:'.length) : q
  const sub = /^(canvas|meetings):(.+)$/.exec(name)
  const key = sub ? null : pageFromKey(name)
  let place: Place | null = null
  if (sub?.[1] === 'canvas') place = placeOf('canvas', { canvas: sub[2]! })
  else if (sub) place = placeOf('meetings', { meeting: sub[2]! })
  else if (key && key !== 'chat') place = placeOf(key)
  if (place) return pageTarget(browserScope(place, 0), place)
  const row = rows.find((r) => r.id === q || r.file === q)
  if (row) return chatTarget(row.file, row.title)
  if (q.startsWith('/') && q.endsWith('.jsonl')) return chatTarget(q, null)
  return fail(
    'invalid-scope',
    `No page or chat "${q}": use a page key (agent:nova, test-bench), a chat session id or a session file`,
  )
}

/** The scope is the one in front, so the action runs as it always has. */
export function inFront(t: ScopeTarget): boolean {
  return t.scope === layoutStore.getState().panelScope
}

/** Resolves a scope against the chat list (loaded on first use). */
export async function targetOf(scope: string): Promise<ScopeTarget> {
  if (!listStore.getState().list) await listStore.getState().load()
  return resolveScope(scope, listStore.getState().list?.rows ?? [])
}

/** A panel action names a valid scope that is not in front: nothing on screen changes. */
export async function isAway(scope: unknown): Promise<boolean> {
  if (typeof scope !== 'string') return false
  try {
    return !inFront(await targetOf(scope))
  } catch {
    return false
  }
}

// Deferred panel views -----------------------------------------------------------------------

/** What a scope not in front shows once Isaac opens it, in the order agents asked. */
const deferred = new Map<string, Array<() => unknown>>()

/** Runs `show` when `scope` next comes to the front. */
export function whenShown(scope: string, show: () => unknown): void {
  const list = deferred.get(scope) ?? []
  list.push(show)
  deferred.set(scope, list)
}

/** Drops what `scope` would have shown (its panel was closed). */
export function forgetShown(scope: string): void {
  deferred.delete(scope)
}

// Badges ------------------------------------------------------------------------------------

export interface BadgeState {
  /** What an agent did in each scope not in front, the latest per scope. */
  badges: Record<string, string>
}

export const badgeStore = createStore<BadgeState>(() => ({ badges: {} }))

/** Every scope's badge, for the tab bar. */
export function useScopeBadges(): Record<string, string> {
  return useStore(badgeStore, (s) => s.badges)
}

/**
 * Tells Isaac what an agent did in a page he is not looking at: a dot on the app tab showing it,
 * else a short toast. Neither takes focus.
 */
export function announce(t: ScopeTarget, what: string): void {
  const message = `${t.actor} ${what}`
  badgeStore.setState((s) => ({ badges: { ...s.badges, [t.scope]: message } }))
  const shown = tabsStore
    .getState()
    .tabs.list.some((tab) => browserScope(tab.here, tab.id) === t.scope)
  if (!shown) {
    notifications.show({
      message: `${message} in ${t.title}`,
      color: 'gray',
      autoClose: 4000,
      withCloseButton: false,
    })
  }
}

/**
 * Clears the badge and runs the deferred views as each scope comes to the front, under a focus
 * hold like any agent action. Returns the unsubscribe.
 */
export function startScopeWatch(): () => void {
  return layoutStore.subscribe((s, prev) => {
    if (s.panelScope === prev.panelScope) return
    const scope = s.panelScope
    if (Object.hasOwn(badgeStore.getState().badges, scope)) {
      badgeStore.setState((b) => {
        const badges = { ...b.badges }
        delete badges[scope]
        return { badges }
      })
    }
    const list = deferred.get(scope)
    if (!list) return
    deferred.delete(scope)
    void withFocusHold(async () => {
      for (const show of list) await show()
    }).catch((e: unknown) => console.warn('deferred agent panel view failed', e))
  })
}

export function resetScopesForTests(): void {
  deferred.clear()
  badgeStore.setState({ badges: {} })
}
