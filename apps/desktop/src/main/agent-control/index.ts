import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { agentCatalog, type AgentResult, type AgentRunners } from '@evaos/contract'
import type { MainContext } from '../context'
import type { UpdateHandle } from '../update'
import { emit, handle } from '../ipc/handle'
import { createReplyRegistry } from '../quit-guard'
import { removeControlFile, writeControlFile } from './control-file'
import { runAgentRequest } from './run'
import { captureWindow } from './screenshot'
import { startControlServer } from './server'

const RENDERER_TIMEOUT_MS = 15_000
const CONFIRM_TIMEOUT_MS = 60_000

/**
 * The agent control API (see server.ts): agents drive the app through the action registry in
 * @evaos/contract instead of CDP. Nothing here shows, raises or focuses the window.
 */
export function registerAgentControl(ctx: MainContext, update: UpdateHandle): void {
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
  }

  const token = randomBytes(32).toString('hex')
  void startControlServer({
    token,
    catalog: agentCatalog,
    screenshot,
    run: (id, body) =>
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
      }),
  })
    .then((server) => {
      const file = writeControlFile(ctx.env.configDir, { port: server.port, token })
      app.on('will-quit', () => removeControlFile(file))
      ctx.onBeforeQuit(() => server.close())
      console.warn(`Agent control on 127.0.0.1:${server.port} (${file})`)
    })
    .catch((e: unknown) => {
      console.error('Agent control did not start:', e)
    })
}
