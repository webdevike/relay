import { ipcMain, session } from 'electron'
import { PASSKEY_CHANNEL } from '../../preload/guest-channel'
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
  // Guest pages' passkey requests (preload/guest.ts); the host ignores senders that aren't its tabs.
  ipcMain.on(PASSKEY_CHANNEL, (event, phase: unknown) => {
    if (phase === 'start' || phase === 'done') host.passkey(event.sender.id, phase)
  })
  // Navigation waits for the extension host so the first page already gets content scripts.
  host.ready = setupExtensions(ctx, host).catch((e: unknown) => {
    console.warn('[extensions] setup failed:', e instanceof Error ? e.message : e)
  })
  // A native view paints over the renderer, so an HTML fullscreen video needs every view hidden.
  ctx.shell.webContents.on('enter-html-full-screen', () => host.setFullscreen(true))
  ctx.shell.webContents.on('leave-html-full-screen', () => host.setFullscreen(false))
  ctx.win.on('closed', () => host.dispose())
  ctx.onBeforeQuit(async () => host.dispose())
  return host
}
