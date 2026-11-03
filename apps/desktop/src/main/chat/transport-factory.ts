import type { ChatTransport } from '@evaos/chat-core/transport'
import type { MainContext } from '../context'
import { loadSettings } from '../settings-ipc'
import { ClaudeBridgeTransport } from './claude-transport'
import { OmpStdioTransport } from './omp-transport'

/**
 * The transport for a new process, chosen by the harness in chat.json at call time (a change in
 * Settings applies to the next chat, never to a running one). `extraEnv` is the e2e spawn seam.
 */
export function createChatTransport(
  ctx: MainContext,
  takeExtraEnv?: () => Record<string, string>,
): { transport: ChatTransport; harness: 'omp' | 'claude' } {
  const harness = loadSettings(ctx.config).harness
  if (harness === 'claude') {
    return {
      harness,
      transport: new ClaudeBridgeTransport({
        bridgeBin: ctx.env.claudeBridgeBin,
        live: ctx.env.live,
        takeExtraEnv,
      }),
    }
  }
  return {
    harness,
    transport: new OmpStdioTransport({
      ompBin: ctx.env.ompBin,
      live: ctx.env.live,
      takeExtraEnv,
    }),
  }
}
