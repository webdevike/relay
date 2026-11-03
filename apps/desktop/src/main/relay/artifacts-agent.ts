// The artifacts.* agent actions: an agent lists, adds and pins what its own thread holds and
// keeps tabs of its own. The thread comes from the request's scope (relay-ctl sends the caller's
// own: `agent:<id>` for an assistant, else its session file); the host checks who may do what
// and its refusal comes back as the action's error, word for word.
import {
  artifactState,
  tabItems,
  type ArtifactAction,
  type ArtifactTab,
} from '@evaos/chat-core/artifacts'
import { sessionId } from '@evaos/chat-core/session-id'
import type { AgentParams, AgentRunners } from '@evaos/contract'
import type { ArtifactsSnapshot, RelayArtifacts, RelaySource } from './client'
import { reactionThreadOf } from './reactions-ipc'
import type { RelaySession } from './feed'

/** Items `artifacts.list` returns at most; the rest are counted. */
export const LIST_LIMIT = 200
/** How long `artifacts.list` waits for a thread's first snapshot. */
const FIRST_SNAPSHOT_MS = 3000

type ArtifactsActionId =
  | 'artifacts.list'
  | 'artifacts.add'
  | 'artifacts.pin'
  | 'artifacts.unpin'
  | 'artifacts.tab.add'
  | 'artifacts.tab.update'
  | 'artifacts.tab.remove'

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

/**
 * The thread a scope names and who acts in it: an assistant page or `agent:<id>` is that
 * assistant's thread, acting as it; a chat (`chat:<file>`, a session file or id) is its session's
 * thread, acting as its assistant or else under the chat's title.
 */
export function artifactsScope(
  scope: string | undefined,
  sessions: ReadonlyMap<string, RelaySession> | null,
): { thread: string; by: string } {
  if (scope === undefined) {
    fail(
      'no-scope',
      'artifacts actions act on the calling session: run them from an omp session (relay-ctl sends it) or pass --scope',
    )
  }
  const agent = /^(?:page:)?agent:([a-z][a-z0-9-]*)$/.exec(scope)?.[1]
  if (agent !== undefined) return { thread: `assistant:${agent}`, by: agent }
  const file = scope.startsWith('chat:') ? scope.slice('chat:'.length) : scope
  const thread = reactionThreadOf(file, null, sessions)
  if (thread === null) fail('bad-scope', `No thread for scope ${scope}`)
  const session = sessions?.get(sessionId(file))
  const by =
    session?.assistant ??
    (session?.title.trim().slice(0, 64) || `chat ${sessionId(file).slice(0, 8)}`)
  return { thread, by }
}

/** A tab as agents read it. */
function tabRow(tab: ArtifactTab): Record<string, unknown> {
  return {
    id: tab.id,
    title: tab.title,
    ...(tab.icon === undefined ? {} : { icon: tab.icon }),
    ...(tab.rule === undefined ? {} : { rule: tab.rule }),
    ...(tab.items === undefined ? {} : { items: tab.items.length }),
    createdBy: tab.createdBy,
    hidden: tab.hidden,
  }
}

export function artifactsRunners(
  relay: RelaySource & RelayArtifacts,
  now: () => number = Date.now,
): Pick<AgentRunners<'main'>, ArtifactsActionId> {
  const where = (scope: string | undefined): { thread: string; by: string } =>
    artifactsScope(scope, relay.sessions())

  const act = async (
    scope: string | undefined,
    action: ArtifactAction,
  ): Promise<{ id?: string }> => {
    const { thread, by } = where(scope)
    const r = await relay.actArtifacts(thread, by, action)
    if (!r.ok) fail('refused', r.error ?? 'Relay refused it')
    return r.id === undefined ? {} : { id: r.id }
  }

  const snapshot = async (thread: string): Promise<ArtifactsSnapshot> => {
    const held = relay.artifacts(thread)
    if (held !== null) return held
    if (!relay.artifactsUp()) fail('not-connected', "Relay isn't connected.")
    const { promise, resolve } = Promise.withResolvers<ArtifactsSnapshot | null>()
    const timer = setTimeout(() => resolve(null), FIRST_SNAPSHOT_MS)
    const off = relay.onArtifacts((t) => {
      if (t === thread) resolve(relay.artifacts(thread))
    })
    relay.watchArtifacts(thread)
    const snap = await promise
    clearTimeout(timer)
    off()
    return snap ?? fail('timeout', "Relay didn't send this thread's artifacts in time.")
  }

  return {
    'artifacts.list': async ({ tab, scope }: AgentParams<'artifacts.list'>) => {
      const { thread } = where(scope)
      const snap = await snapshot(thread)
      const shown = tab ?? 'everything'
      const target = snap.tabs.find((t) => t.id === shown)
      if (target === undefined)
        fail('no-tab', `No tab ${shown}; tabs: ${snap.tabs.map((t) => t.id).join(', ')}`)
      const rows = tabItems(target, snap.items, now())
      return {
        thread,
        tabs: snap.tabs.map(tabRow),
        tab: target.id,
        items: rows.slice(0, LIST_LIMIT).map((item) => ({
          id: item.id,
          kind: item.kind,
          title: item.title,
          ...(item.url === undefined ? {} : { url: item.url }),
          ...(item.path === undefined ? {} : { path: item.path }),
          ...(artifactState(item) === null ? {} : { state: artifactState(item) }),
          pinned: item.pinned !== undefined,
        })),
        ...(rows.length > LIST_LIMIT ? { more: rows.length - LIST_LIMIT } : {}),
      }
    },
    'artifacts.add': ({ scope, ...rest }: AgentParams<'artifacts.add'>) =>
      act(scope, { op: 'add', ...rest }),
    'artifacts.pin': ({ id, scope }: AgentParams<'artifacts.pin'>) =>
      act(scope, { op: 'pin', id, pinned: true }),
    'artifacts.unpin': ({ id, scope }: AgentParams<'artifacts.unpin'>) =>
      act(scope, { op: 'pin', id, pinned: false }),
    'artifacts.tab.add': ({ scope, ...rest }: AgentParams<'artifacts.tab.add'>) =>
      act(scope, { op: 'tab.add', ...rest }),
    'artifacts.tab.update': ({ id, scope, ...rest }: AgentParams<'artifacts.tab.update'>) =>
      act(scope, { op: 'tab.update', tab: id, ...rest }),
    'artifacts.tab.remove': ({ id, scope }: AgentParams<'artifacts.tab.remove'>) =>
      act(scope, { op: 'tab.remove', tab: id }),
  }
}
