import { session } from 'electron'
import type { MainContext } from '../context'
import { registerTestHook, registerViewProvider } from '../test-hooks'
import { BrowserHost } from './browser-host'
import { registerBrowserIpc } from './browser-ipc'
import { setupExtensions } from './extensions'
import { GUEST_PARTITION, setupGuestSession } from './guest-session'
import { installTabAppCookies } from './tab-app-cookies'

export function registerBrowser(ctx: MainContext): BrowserHost {
  setupGuestSession(ctx.env)
  const host = new BrowserHost(ctx)
  installTabAppCookies(session.fromPartition(GUEST_PARTITION), host)
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
