import {
  ReactionThreadSchema,
  assistantReactionThread,
  sessionReactionThread,
} from '@evaos/chat-core/reactions'
import { sessionId } from '@evaos/chat-core/session-id'
import type { ReactionsView } from '@evaos/contract'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import type { RelayReactions, RelaySource } from './client'
import type { RelaySession } from './feed'

/**
 * The reaction thread of the chat in `file`: its agent's (an assistant page names `agent`; a
 * session Relay lists as an assistant's thread is its agent's too), else the session's own. Null
 * for a chat without a session file yet, or a name the host would not take.
 */
export function reactionThreadOf(
  file: string,
  agent: string | null,
  sessions: ReadonlyMap<string, RelaySession> | null,
): string | null {
  let thread: string
  if (agent !== null) thread = assistantReactionThread(agent)
  else if (file === '') return null
  else {
    const id = sessionId(file)
    thread = sessionReactionThread(sessions?.get(id) ?? { id })
  }
  return ReactionThreadSchema.safeParse(thread).success ? thread : null
}

/**
 * `reactions.watch` / `unwatch` / `react`, `reactions.changed` after each snapshot of a watched
 * thread, and `reactions.status` when Relay comes up or goes down. A thread stays watched while
 * any chat shows it.
 */
export function registerReactionsIpc(
  ctx: MainContext,
  relay: RelaySource & RelayReactions,
): () => void {
  const watched = new Map<string, number>()
  const view = (thread: string): ReactionsView & { thread: string } => ({
    thread,
    up: relay.reactionsUp(),
    reactions: { ...relay.reactions(thread) },
    bookmarks: relay.bookmarksUp() ? relay.bookmarks(thread) : null,
    bookmarksUp: relay.bookmarksUp(),
  })
  handle(ctx, 'reactions.watch', ({ file, agent }) => {
    const thread = reactionThreadOf(file, agent, relay.sessions())
    if (thread === null)
      return {
        thread: null,
        up: relay.reactionsUp(),
        reactions: {},
        bookmarks: null,
        bookmarksUp: false,
      }
    watched.set(thread, (watched.get(thread) ?? 0) + 1)
    relay.watchReactions(thread)
    return view(thread)
  })
  handle(ctx, 'reactions.unwatch', ({ thread }) => {
    const left = (watched.get(thread) ?? 0) - 1
    if (left > 0) watched.set(thread, left)
    else if (watched.delete(thread)) relay.unwatchReactions(thread)
    return {}
  })
  handle(ctx, 'reactions.react', ({ thread, message, emoji, excerpt }) => ({
    sent: watched.has(thread) && relay.react(thread, message, emoji, excerpt),
  }))
  handle(ctx, 'reactions.bookmark', ({ thread, message, on }) => ({
    sent: watched.has(thread) && relay.bookmark(thread, message, on),
  }))
  const offReactions = relay.onReactions((thread) => emit(ctx, 'reactions.changed', view(thread)))
  let up = relay.reactionsUp()
  const offStatus = relay.onChange(() => {
    if (relay.reactionsUp() === up) return
    up = !up
    emit(ctx, 'reactions.status', { up })
  })
  return () => {
    offReactions()
    offStatus()
  }
}
