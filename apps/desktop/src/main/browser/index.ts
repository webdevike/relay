import type { MainContext } from '../context'
import { registerTestHook, registerViewProvider } from '../test-hooks'
import { BrowserHost } from './browser-host'
import { registerBrowserIpc } from './browser-ipc'
import { setupExtensions } from './extensions'
import { setupGuestSession } from './guest-session'

export function registerBrowser(ctx: MainContext): BrowserHost {
  setupGuestSession(ctx.env)
  const host = new BrowserHost(ctx)
  registerBrowserIpc(ctx, host)
  registerViewProvider(() => host.views())
  registerTestHook('browser', { host, pageControl: (id: string) => host.pageControl(id) })
  // Navigation waits for the extension host so the first page already gets content scripts.
  host.ready = setupExtensions(ctx, host).catch((e: unknown) => {
    console.warn('[extensions] setup failed:', e instanceof Error ? e.message : e)
  })
  ctx.win.on('closed', () => host.dispose())
  ctx.onBeforeQuit(async () => host.dispose())
  return host
}
