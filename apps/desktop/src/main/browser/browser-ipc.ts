import { normalize } from '@evaos/browser-core/address'
import { isAppSwitchUrl } from '@evaos/browser-core/app-switch'
import type { MainContext } from '../context'
import { handle } from '../ipc/handle'
import { session } from 'electron'
import { listSwitchApps, selectSwitchApp, type SessionFetch } from './app-switch'
import { importArcLogins } from './arc-import'
import { GUEST_PARTITION } from './guest-session'
import { listExtensions } from './extensions'
import type { BrowserHost } from './browser-host'

export function registerBrowserIpc(ctx: MainContext, host: BrowserHost): void {
  handle(ctx, 'browser.state', () => host.snapshot())
  handle(ctx, 'browser.navigate', async ({ tabId, input }) => {
    await host.ready
    const url = normalize(input)
    if (url === null) return { url: null }
    host.navigate(tabId, url)
    return { url }
  })
  const simple = [
    ['browser.back', (id: string) => host.back(id)],
    ['browser.forward', (id: string) => host.forward(id)],
    ['browser.reload', (id: string) => host.reload(id)],
    ['browser.stop', (id: string) => host.stop(id)],
    ['browser.copyLink', (id: string) => host.copyLink(id)],
    ['browser.openExternal', (id: string) => host.openExternal(id)],
  ] as const
  for (const [channel, fn] of simple) {
    handle(ctx, channel, ({ tabId }) => {
      fn(tabId)
      return { ok: true as const }
    })
  }
  handle(ctx, 'browser.createTab', async ({ url }) => {
    await host.ready
    const tab = host.createTab(url ? (normalize(url) ?? undefined) : undefined, true)
    if (!tab) throw Object.assign(new Error('Tab limit reached'), { code: 'tab-limit' })
    return tab
  })
  handle(ctx, 'browser.closeTab', ({ tabId }) => ({ activeId: host.closeTab(tabId) }))
  handle(ctx, 'browser.activateTab', ({ tabId }) => ({ activeId: host.activateTab(tabId) }))
  // The first scope revives the restored active tab: let content scripts be ready for it.
  handle(ctx, 'browser.setScope', async ({ scope }) => {
    await host.ready
    return host.setScope(scope)
  })
  handle(ctx, 'browser.renameScope', ({ from, to }) => {
    host.renameScope(from, to)
    return { ok: true as const }
  })
  handle(ctx, 'browser.pinTab', ({ tabId, pinned }) => host.pinTab(tabId, pinned))
  handle(ctx, 'browser.suggest', ({ text }) => ({ items: host.history.suggest(text) }))
  handle(ctx, 'browser.openDevTools', ({ tabId }) => {
    host.openDevTools(tabId)
    return { ok: true as const }
  })
  handle(ctx, 'browser.extensions', () => ({ extensions: listExtensions() }))
  handle(ctx, 'browser.importArc', () =>
    importArcLogins(ctx.env, session.fromPartition(GUEST_PARTITION), host),
  )
  // The guest session's fetch carries the tab's cookies both ways, so a switch lands in the page's jar.
  const guestFetch: SessionFetch = (url, init) =>
    session.fromPartition(GUEST_PARTITION).fetch(url, init)
  handle(ctx, 'browser.switchApps', async () => ({ apps: await listSwitchApps(guestFetch) }))
  handle(ctx, 'browser.switchApp', async ({ tabId, id }) => {
    const active = await selectSwitchApp(guestFetch, id)
    const page = host.tabById(tabId)
    if (page && isAppSwitchUrl(page.getURL())) host.reload(tabId)
    return { active }
  })
  handle(ctx, 'browser.setSlot', (rect) => {
    host.setSlot(rect)
    return { ok: true as const }
  })
  handle(ctx, 'browser.setOccluded', ({ occluded }) => ({ visible: host.setOccluded(occluded) }))
}
