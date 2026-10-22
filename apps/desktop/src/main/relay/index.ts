import * as os from 'node:os'
import type { MainContext } from '../context'
import { registerTestHook } from '../test-hooks'
import { RelayClient, StaticRelay, type RelaySource } from './client'
import { relayConfigDir } from './device'
import { parseSession, type RelaySession } from './feed'

/**
 * Relay's feed for the chat list. Live: a client that stays connected to the local Relay host
 * and stops at quit. Fixtures and e2e: never connected, unless an e2e test sets sessions through
 * the `relay` test hook (`set(sessions | null)`, sessions in Relay's wire shape).
 */
export function startRelay(ctx: MainContext): RelaySource {
  if (ctx.env.live && !ctx.env.e2e) {
    const client = new RelayClient({ configDir: relayConfigDir(process.env, os.homedir()) })
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
