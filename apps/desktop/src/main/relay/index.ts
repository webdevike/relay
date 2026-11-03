import * as os from 'node:os'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import { createReplyRegistry } from '../quit-guard'
import { registerTestHook } from '../test-hooks'
import {
  RelayClient,
  StaticRelay,
  type RelayArtifacts,
  type RelayCanvas,
  type RelayFrames,
  type RelayLink,
  type RelayQueries,
  type RelayReactions,
  type RelayStudio,
  type RemoteHost,
} from './client'
import { remoteDeviceId, remoteSecretStore, type RelayRemote } from './device'
import { parseArtifacts, parseSession, type RelaySession } from './feed'

/** How long the PIN prompt waits: the host gives a pairing two minutes. */
const PIN_WAIT_MS = 120_000

/**
 * Relay for the chat list and the chat pane. With a remote host (`relayRemote`) or a Relay folder
 * (live, or an e2e fake host through EVAOS_RELAY_DIR): a client that stays connected to that host
 * and stops at quit; a remote host is paired once with the PIN from its log, asked for in the
 * window. Otherwise never connected, unless an e2e test sets sessions through the `relay` test
 * hook (`set(sessions | null)`, sessions in Relay's wire shape).
 */
export function startRelay(
  ctx: MainContext,
): RelayLink &
  RelayReactions &
  RelayArtifacts &
  RelayCanvas &
  RelayFrames &
  RelayStudio &
  RelayQueries {
  const remote = ctx.env.relayRemote
  if (remote !== null || ctx.env.relayDir !== null) {
    const client = new RelayClient({
      configDir: ctx.env.relayDir,
      ...(remote && { remote: remoteHost(ctx, remote) }),
    })
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
      // A thread's `artifacts.snapshot`, in Relay's wire shape.
      artifacts: (thread: string, items: unknown[], tabs: unknown[]) =>
        fake.setArtifacts(thread, parseArtifacts(items, tabs)),
    })
  }
  return fake
}

/** `remote` with this app's pairing for it, asking the window for the PIN. */
function remoteHost(ctx: MainContext, remote: RelayRemote): RemoteHost {
  const pins = createReplyRegistry()
  handle(ctx, 'relay.pin.reply', ({ id, pin }) => {
    pins.resolve(id, pin)
    return {}
  })
  return {
    ...remote,
    ...remoteSecretStore(ctx.config, remote),
    deviceId: remoteDeviceId(os.hostname()),
    askPin: (retry) =>
      pins.request<string | null>(
        (id) => emit(ctx, 'relay.pin.request', { id, retry }),
        PIN_WAIT_MS,
        null,
      ),
  }
}
