import * as path from 'node:path'
import { session } from 'electron'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { installChromeWebStore, installExtension } from 'electron-chrome-web-store'
import type { MainContext } from '../context'
import type { BrowserHost } from './browser-host'
import { GUEST_PARTITION } from './guest-session'

export const BITWARDEN_ID = 'nngceckbapebfimnlniiiahkandclblb'

export interface ExtensionInfo {
  id: string
  name: string
  version: string
}

let host: ElectronChromeExtensions | null = null

export function getExtensionHost(): ElectronChromeExtensions | null {
  return host
}

export function listExtensions(): ExtensionInfo[] {
  const ses = session.fromPartition(GUEST_PARTITION)
  return ses.extensions
    .getAllExtensions()
    .map((e) => ({ id: e.id, name: e.name, version: e.version }))
}

/**
 * Chrome extension host bound to the persist:browser session only (D-12, T-01-43).
 * The shell session is never touched. Resolves once the host, the Web Store and any
 * test extension are in place, so the first guest page already sees content scripts.
 */
export async function setupExtensions(ctx: MainContext, browser: BrowserHost): Promise<void> {
  if (process.env.EVAOS_NO_EXTENSIONS === '1') return
  const guest = session.fromPartition(GUEST_PARTITION)

  const idOf = (wc: Electron.WebContents): string | undefined => browser.tabByWebContents(wc.id)?.id

  const extensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: guest,
    createTab: async (details) => {
      const tab = browser.createTab(details.url, details.active !== false, {
        fromExtension: true,
      })
      if (!tab) throw new Error('Tab limit reached')
      const wc = browser.tabById(tab.id)
      if (!wc) throw new Error('tab vanished')
      return [wc, ctx.win]
    },
    selectTab: (wc) => {
      const id = idOf(wc)
      if (id) browser.activateTab(id)
    },
    removeTab: (wc) => {
      const id = idOf(wc)
      if (id) browser.closeTab(id)
    },
  })
  host = extensions
  // crx:// icons are shown by <browser-action-list> in the shell page, so the protocol lives on the shell session.
  ElectronChromeExtensions.handleCRXProtocol(ctx.shell.webContents.session)

  browser.onTabCreated((_tab, view) => extensions.addTab(view.webContents, ctx.win))
  browser.onTabActivated((_tab, view) => extensions.selectTab(view.webContents))
  browser.onTabClosed((_tab, view) => {
    if (!view.webContents.isDestroyed()) extensions.removeTab(view.webContents)
  })
  // Tabs that existed before the hooks were registered.
  for (const view of browser.views()) extensions.addTab(view.webContents, ctx.win)
  const active = browser.activeView()
  if (active) extensions.selectTab(active.webContents)

  const extensionsPath = path.join(ctx.env.configDir, 'extensions')
  await installChromeWebStore({
    session: guest,
    extensionsPath,
    allowlist: [BITWARDEN_ID],
    autoUpdate: !ctx.env.e2e,
  })

  const testDir = process.env.EVAOS_TEST_EXTENSION_DIR
  if (testDir) {
    try {
      await guest.extensions.loadExtension(testDir)
    } catch (e) {
      console.warn('[extensions] test extension failed to load:', (e as Error).message)
    }
  }

  const wantBitwarden = !ctx.env.e2e || process.env.EVAOS_BITWARDEN_INSTALL === '1'
  if (wantBitwarden && !guest.extensions.getAllExtensions().some((e) => e.id === BITWARDEN_ID)) {
    void installExtension(BITWARDEN_ID, { session: guest, extensionsPath }).catch((e: unknown) => {
      console.warn('[extensions] Bitwarden install failed:', e instanceof Error ? e.message : e)
    })
  }
}
