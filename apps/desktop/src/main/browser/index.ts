import { ipcMain, session } from 'electron'
import { DESIGN_STYLE_KEYS } from '@evaos/contract'
import { PASSKEY_CHANNEL } from '../../preload/guest-channel'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import { registerTestHook, registerViewProvider } from '../test-hooks'
import { BrowserHost } from './browser-host'
import { registerBrowserIpc } from './browser-ipc'
import { DesignMode } from './design-mode'
import { designPage } from './design-page'
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
  registerDesignMode(ctx, host)
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

/** Design Mode in page tabs (design-mode.ts): its IPC and its test hook. */
function registerDesignMode(ctx: MainContext, host: BrowserHost): void {
  const design = new DesignMode(
    {
      page: (tabId) => designPage(host.pageControl(tabId), DESIGN_STYLE_KEYS),
      contents: (tabId) => host.tabById(tabId),
      onTabClosed: (cb) => host.onTabClosed(cb),
      interceptInput: (fn) => host.interceptInput(fn),
    },
    (channel, payload) => emit(ctx, channel, payload),
  )
  handle(ctx, 'design.set', async ({ tabId, on }) => {
    await design.set(tabId, on)
    return { ok: true as const }
  })
  handle(ctx, 'design.select', async ({ tabId, selectors }) => {
    await design.select(tabId, selectors)
    return { ok: true as const }
  })
  handle(ctx, 'design.style', async ({ tabId, selector, property, value }) => {
    await design.style(tabId, selector, property, value)
    return { ok: true as const }
  })
  // A Shift-click into a page while the shell has the keyboard (the usual case): Shift is read
  // from the shell's key events.
  ctx.shell.webContents.on('before-input-event', (_event, input) => design.keyState(input))
  // Shift released in another app never reaches us.
  ctx.win.on('blur', () => design.keyState({ shift: false }))
  registerTestHook('design', design)
  ctx.win.on('closed', () => design.dispose())
}
