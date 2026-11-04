import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import * as os from 'node:os'
import {
  AGENT_PAGES,
  AGENT_SETTINGS_SECTIONS,
  CONNECTIONS,
  agentCatalog,
  appLinkFor,
  type AgentResult,
  type AgentRunners,
} from '@evaos/contract'
import type { Connections } from '../connections/connections'
import type { MainContext } from '../context'
import type { UpdateHandle } from '../update'
import { emit, handle } from '../ipc/handle'
import { createReplyRegistry } from '../quit-guard'
import { removeControlFile, writeControlFile } from './control-file'
import { runAgentRequest } from './run'
import { startRemoteControl, type RemoteControl } from './remote'
import { captureWindow } from './screenshot'
import { startControlServer, type RunBody } from './server'
import { artifactsRunners } from '../relay/artifacts-agent'
import { canvasLiveRunners } from '../relay/canvas-live-agent'
import { studioRunners } from '../relay/studio-agent'
import type {
  RelayArtifacts,
  RelayCanvas,
  RelayFrames,
  RelaySource,
  RelayStudio,
} from '../relay/client'

const RENDERER_TIMEOUT_MS = 15_000
const CONFIRM_TIMEOUT_MS = 60_000

/**
 * The agent control API (see server.ts): agents drive the app through the action registry in
 * @evaos/contract instead of CDP. Nothing here shows, raises or focuses the window. The same
 * requests also arrive from the Relay Host (remote.ts), for agents on the Mini when Isaac uses
 * this Mac.
 */
export function registerAgentControl(
  ctx: MainContext,
  update: UpdateHandle,
  artifacts: RelaySource & RelayArtifacts,
  canvas: RelayCanvas,
  studio: RelayStudio & Pick<RelayCanvas, 'canvasOrigin'>,
  connections: Connections,
  frames: RelayFrames,
): void {
  const runs = createReplyRegistry()
  const confirms = createReplyRegistry()
  handle(ctx, 'agent.reply', ({ id, result }) => {
    runs.resolve(id, result)
    return {}
  })
  handle(ctx, 'agent.confirm.reply', ({ id, approved }) => {
    confirms.resolve(id, approved)
    return {}
  })
  // When Isaac last used the window and what is in front, for the host's "active" Mac.
  let lastInputAt: number | null = null
  let page: string | null = null
  let remote: RemoteControl | null = null
  handle(ctx, 'agent.presence', ({ page: p, input }) => {
    page = p
    if (input) lastInputAt = Date.now()
    remote?.changed()
    return {}
  })
  if (!ctx.env.agentControl) return

  const renderer = (action: string, params: unknown): Promise<AgentResult> => {
    if (ctx.shell.webContents.isDestroyed() || ctx.shell.webContents.isLoading()) {
      return Promise.resolve({
        ok: false,
        code: 'renderer-unavailable',
        message: 'The app page is not loaded',
      })
    }
    return runs.request<AgentResult>(
      (id) => emit(ctx, 'agent.run', { id, action, params }),
      RENDERER_TIMEOUT_MS,
      { ok: false, code: 'renderer-timeout', message: 'The app page did not answer' },
    )
  }

  const screenshot = (): Promise<Buffer> => captureWindow(ctx.win, ctx.shell)

  const main: AgentRunners<'main'> = {
    'state.read': async () => {
      const r = await renderer('@state', {})
      if (!r.ok) throw Object.assign(new Error(r.message), { code: r.code })
      const b = ctx.win.getBounds()
      return {
        window: {
          focused: ctx.win.isFocused(),
          visible: ctx.win.isVisible(),
          minimized: ctx.win.isMinimized(),
          bounds: b,
        },
        ...(r.value as object),
        instance: ctx.env.instance,
        build: ctx.env.build,
        update: update.state(),
      }
    },
    'window.screenshot': async () => {
      const png = await screenshot()
      return { png: png.toString('base64'), bytes: png.length }
    },
    'app.quit': () => {
      setImmediate(() => app.quit())
      return { quitting: true }
    },
    'update.offer': (params) => update.offer(params),
    'pages.list': () => ({ pages: AGENT_PAGES, settingsSections: AGENT_SETTINGS_SECTIONS }),
    'connections.list': async () => ({ connections: await connections.list() }),
    'connections.add': async ({ id, secret, scope }) => {
      const r = await connections.add(id, secret)
      if (r.status === 'connected' && secret !== undefined) {
        await renderer('@announce', { scope, text: `connected ${CONNECTIONS[id].title}` })
      }
      return r
    },
    'connections.remove': async ({ id, scope }) => {
      await connections.remove(id)
      await renderer('@announce', { scope, text: `disconnected ${CONNECTIONS[id].title}` })
      return { removed: id }
    },
    link: (params) => appLinkFor(params),
    ...artifactsRunners(artifacts),
    ...canvasLiveRunners(canvas),
    ...studioRunners(studio, (p) => renderer('studio.open', p)),
  }

  const token = randomBytes(32).toString('hex')
  const run = (id: string, body: RunBody): Promise<AgentResult> =>
    runAgentRequest(id, body, {
      run: async (aid, spec, params) => {
        if (spec.side === 'renderer') return renderer(aid, params)
        const fn = main[aid as keyof typeof main] as (p: unknown) => unknown
        return { ok: true, value: await fn(params) }
      },
      ask: (aid, spec, params) =>
        confirms.request<boolean>(
          (id) =>
            emit(ctx, 'agent.confirm', {
              id,
              title: spec.title,
              detail: `${aid} ${JSON.stringify(params)}`.slice(0, 300),
              timeoutMs: CONFIRM_TIMEOUT_MS,
            }),
          CONFIRM_TIMEOUT_MS,
          false,
        ),
    })

  void startControlServer({ token, catalog: agentCatalog, screenshot, run })
    .then((server) => {
      const file = writeControlFile(ctx.env.configDir, { port: server.port, token })
      app.on('will-quit', () => removeControlFile(file))
      ctx.onBeforeQuit(() => server.close())
      console.warn(`Agent control on 127.0.0.1:${server.port} (${file})`)
    })
    .catch((e: unknown) => {
      console.error('Agent control did not start:', e)
    })

  const live = startRemoteControl({
    frames,
    run,
    catalog: agentCatalog,
    presence: () => ({
      name: os.hostname().replace(/\.local$/, ''),
      instance: ctx.env.instance,
      idleMs: lastInputAt === null ? null : Math.max(0, Date.now() - lastInputAt),
      page,
      focused: !ctx.win.isDestroyed() && ctx.win.isFocused(),
      remote: ctx.env.relayRemote !== null,
    }),
  })
  remote = live
  // Bringing the window forward is using it; leaving it changes only `focused`.
  ctx.win.on('focus', () => {
    lastInputAt = Date.now()
    live.changed()
  })
  ctx.win.on('blur', () => live.changed())
  ctx.onBeforeQuit(async () => live.stop())
}
