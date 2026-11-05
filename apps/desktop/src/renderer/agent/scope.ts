import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { ChatRow } from '@evaos/contract'
import { pageFromKey, placeOf, type Place } from '@evaos/shell-core'
import { agentTitle } from '../eva/names-store'
import { listStore } from '../chat/list/list-store'
import { tilingStore } from '../tiling/tiling-store'
import { tabTitle } from '../tabs/tab-meta'
import { workspaceOfPlace } from '../tabs/workspace-of'
import { withFocusHold } from './focus-safety'

/**
 * Where an agent's content action lands: the workspace it works in (its assistant's, when the
 * session is one an assistant owns; else its chat's or page's), even when Isaac is looking at
 * another one. The change goes into that workspace's panes without switching workspaces, and its
 * sidebar row shows a quiet dot until he opens it.
 */
export interface ScopeTarget {
  /** The workspace key (also its browser scope): `page:agent:nova`, `chat:<file>`, `page:jobs`. */
  scope: string
  /** The workspace's title. */
  title: string
  /** The chat file a chat scope shows (the Files panel's worktree); null for pages. */
  chatFile: string | null
  /** Who acted, as the dot's tooltip names it: the agent of an agent page, else Eva. */
  actor: string
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

function pageTarget(place: Place): ScopeTarget {
  const agent = place.page.startsWith('agent:') ? place.page.slice('agent:'.length) : null
  return {
    scope: workspaceOfPlace(place),
    title: tabTitle(place),
    chatFile: null,
    actor: agent === null ? 'Eva' : (agentTitle(agent) ?? agent),
  }
}

function chatTarget(file: string, title: string | null): ScopeTarget {
  const place = placeOf('chat', { chat: file })
  const scope = workspaceOfPlace(place)
  const agent = scope.startsWith('page:agent:') ? scope.slice('page:agent:'.length) : null
  return {
    scope,
    title: agent === null ? (title ?? tabTitle(place)) : (agentTitle(agent) ?? agent),
    chatFile: file,
    // A session working for an assistant names itself; a plain chat is Eva's.
    actor: agent === null ? 'Eva' : (title ?? 'Eva'),
  }
}

/**
 * A scope as agents name it: a page key (`agent:nova`, `test-bench`, `workspace:<slug>`), a chat
 * session id or file (listed or not), or a workspace key (`page:…`, `chat:…`). A session an
 * assistant owns resolves to that assistant's workspace.
 */
export function resolveScope(input: string, rows: readonly ChatRow[]): ScopeTarget {
  const q = input.trim()
  if (q.startsWith('chat:') && q.length > 'chat:'.length) {
    const file = q.slice('chat:'.length)
    return chatTarget(file, rows.find((r) => r.file === file)?.title ?? null)
  }
  if (/^draft:\d+$/.test(q)) return { scope: q, title: 'New chat', chatFile: null, actor: 'Eva' }
  // A page key, or the workspace key of one (`page:agent:nova`, `page:canvas:<id>`).
  const name = q.startsWith('page:') ? q.slice('page:'.length) : q
  const sub = /^(canvas|meetings):(.+)$/.exec(name)
  const key = sub ? null : pageFromKey(name)
  let place: Place | null = null
  if (sub?.[1] === 'canvas') place = placeOf('canvas', { canvas: sub[2]! })
  else if (sub) place = placeOf('meetings', { meeting: sub[2]! })
  else if (key && key !== 'chat') place = placeOf(key)
  if (place) return pageTarget(place)
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
  return t.scope === tilingStore.getState().scope
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

// Deferred tool tab views -----------------------------------------------------------------------

/** What a scope not in front shows once Isaac opens it, in the order agents asked. */
const deferred = new Map<string, Array<() => unknown>>()

/** Runs `show` when `scope` next comes to the front. */
export function whenShown(scope: string, show: () => unknown): void {
  const list = deferred.get(scope) ?? []
  list.push(show)
  deferred.set(scope, list)
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
 * Tells Isaac what an agent did in a workspace he is not looking at: a quiet dot on its sidebar
 * row (and its tab, where one shows), until he opens it. Nothing takes focus or pops up.
 */
export function announce(t: ScopeTarget, what: string): void {
  const message = `${t.actor} ${what}`
  badgeStore.setState((s) => ({ badges: { ...s.badges, [t.scope]: message } }))
}

/**
 * Clears the badge and runs the deferred views as each scope comes to the front, under a focus
 * hold like any agent action. Returns the unsubscribe.
 */
export function startScopeWatch(): () => void {
  return tilingStore.subscribe((s, prev) => {
    if (s.scope === prev.scope) return
    const scope = s.scope
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
