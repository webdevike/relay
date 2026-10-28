import { shell } from 'electron'
import type { ArtifactsView } from '@evaos/contract'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import type { RelayArtifacts, RelaySource } from './client'
import { reactionThreadOf } from './reactions-ipc'

/** Isaac, as the host knows him: anything done from the panel is his. */
export const ISAAC = 'isaac'

/**
 * `artifacts.watch` / `unwatch` / `act`, `artifacts.changed` after each snapshot of a watched
 * thread, and `artifacts.status` when Relay comes up or goes down. A thread's key is its
 * reactions thread; it stays watched while any panel shows it.
 */
export function registerArtifactsIpc(
  ctx: MainContext,
  relay: RelaySource & RelayArtifacts,
): () => void {
  const watched = new Map<string, number>()
  const view = (thread: string): ArtifactsView & { thread: string } => {
    const snap = relay.artifacts(thread)
    return {
      thread,
      up: relay.artifactsUp(),
      loaded: snap !== null,
      items: snap?.items ?? [],
      tabs: snap?.tabs ?? [],
    }
  }
  handle(ctx, 'artifacts.watch', ({ file, agent }) => {
    const thread = reactionThreadOf(file, agent, relay.sessions())
    if (thread === null) {
      return { thread: null, up: relay.artifactsUp(), loaded: false, items: [], tabs: [] }
    }
    watched.set(thread, (watched.get(thread) ?? 0) + 1)
    relay.watchArtifacts(thread)
    return view(thread)
  })
  handle(ctx, 'artifacts.unwatch', ({ thread }) => {
    const left = (watched.get(thread) ?? 0) - 1
    if (left > 0) watched.set(thread, left)
    else if (watched.delete(thread)) relay.unwatchArtifacts(thread)
    return {}
  })
  handle(ctx, 'artifacts.act', ({ thread, action }) => relay.actArtifacts(thread, ISAAC, action))
  handle(ctx, 'artifacts.openExternal', ({ url }) => {
    const web = /^https?:$/.test(new URL(url).protocol)
    if (web) void shell.openExternal(url)
    return { opened: web }
  })
  // The host pushes every thread; only the ones a panel shows reach the page.
  const offArtifacts = relay.onArtifacts((thread) => {
    if (watched.has(thread)) emit(ctx, 'artifacts.changed', view(thread))
  })
  let up = relay.artifactsUp()
  const offStatus = relay.onChange(() => {
    if (relay.artifactsUp() === up) return
    up = !up
    emit(ctx, 'artifacts.status', { up })
  })
  return () => {
    offArtifacts()
    offStatus()
  }
}
