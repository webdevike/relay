import type { MainContext } from '../context'
import { registerTestHook, registerViewProvider } from '../test-hooks'
import { BrowserHost } from './browser-host'
import { registerBrowserIpc } from './browser-ipc'
import { setupGuestSession } from './guest-session'

export function registerBrowser(ctx: MainContext): BrowserHost {
  setupGuestSession(ctx.env)
  const host = new BrowserHost(ctx)
  registerBrowserIpc(ctx, host)
  registerViewProvider(() => host.views())
  registerTestHook('browser', { host })
  host.createTab()
  ctx.win.on('closed', () => host.dispose())
  ctx.onBeforeQuit(async () => host.dispose())
  return host
}
