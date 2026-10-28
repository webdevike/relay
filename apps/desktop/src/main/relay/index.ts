import type { MainContext } from '../context'
import { registerTestHook } from '../test-hooks'
import { RelayClient, StaticRelay, type RelayLink, type RelayReactions } from './client'
import { parseSession, type RelaySession } from './feed'

/**
 * Relay for the chat list and the chat pane. With a Relay folder (live, or an e2e fake host through
 * EVAOS_RELAY_DIR): a client that stays connected to that host and stops at quit. Otherwise never
 * connected, unless an e2e test sets sessions through the `relay` test hook (`set(sessions | null)`,
 * sessions in Relay's wire shape).
 */
export function startRelay(ctx: MainContext): RelayLink & RelayReactions {
  if (ctx.env.relayDir !== null) {
    const client = new RelayClient({ configDir: ctx.env.relayDir })
    client.start()
    ctx.onBeforeQuit(async () => client.stop())
    return client
  }
  const fake = new StaticRelay()
  if (ctx.env.e2e) {
    registerTestHook('relay', {
      set: (sessions: unknown[] | null) =>
        fake.set(
          sessions === null
            ? null
            : sessions.map(parseSession).filter((s): s is RelaySession => s !== null),
        ),
    })
  }
  return fake
}
