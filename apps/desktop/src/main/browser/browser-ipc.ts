import { normalize } from '@evaos/browser-core/address'
import type { MainContext } from '../context'
import { handle } from '../ipc/handle'
import { app, session } from 'electron'
import { listSwitchApps, type SessionFetch } from './app-switch'
import { importArcLogins } from './arc-import'
import { GUEST_PARTITION } from './guest-session'
import { listExtensions } from './extensions'
import type { BrowserHost } from './browser-host'

export function registerBrowserIpc(ctx: MainContext, host: BrowserHost): void {
  handle(ctx, 'browser.state', ({ scope }) => host.snapshot(scope))
  handle(ctx, 'browser.tabs.get', ({ ids }) => ({ tabs: host.tabStates(ids) }))
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
    ['browser.dismissPasskey', (id: string) => host.dismissPasskey(id)],
  ] as const
  for (const [channel, fn] of simple) {
    handle(ctx, channel, ({ tabId }) => {
      fn(tabId)
      return { ok: true as const }
    })
  }
  handle(ctx, 'browser.systemBrowser', () => ({
    name: app.getApplicationNameForProtocol('https://') || null,
  }))
  handle(ctx, 'browser.createTab', async ({ url, scope, openedBy, background, agent }) => {
    await host.ready
    const tab = host.createTab(url ? (normalize(url) ?? undefined) : undefined, !background, {
      scope,
      ...(openedBy ? { openedBy } : {}),
      ...(agent ? { agent } : {}),
    })
    if (!tab) throw Object.assign(new Error('Tab limit reached'), { code: 'tab-limit' })
    return tab
  })
  handle(ctx, 'browser.closeTab', ({ tabId }) => ({ activeId: host.closeTab(tabId) }))
  handle(ctx, 'browser.activateTab', ({ tabId, scope }) => ({
    activeId: host.activateTab(tabId, scope),
  }))
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
  // Main's own fetch belongs to no tab: the switch answers for the partition cookie, and
  // listSwitchApps marks the tab's own app active instead (tab-app-cookies.ts).
  const guestFetch: SessionFetch = (url, init) =>
    session.fromPartition(GUEST_PARTITION).fetch(url, init)
  handle(ctx, 'browser.switchApps', async ({ tabId }) => ({
    apps: await listSwitchApps(
      guestFetch,
      tabId === undefined ? undefined : host.switchAppOf(tabId),
    ),
  }))
  handle(ctx, 'browser.switchApp', async ({ tabId, id }) => {
    const apps = await listSwitchApps(guestFetch)
    if (!apps.some((a) => a.id === id)) {
      const known = apps.map((a) => a.id).join(', ') || 'none'
      throw Object.assign(new Error(`The app switch has no app "${id}" (registered: ${known}).`), {
        code: 'unknown-app',
      })
    }
    host.setSwitchApp(tabId, id)
    return { active: id }
  })
  handle(ctx, 'browser.setSlots', async ({ slots }) => {
    // A dormant slotted tab revives: let content scripts be ready for it.
    await host.ready
    host.setSlots(slots)
    return { ok: true as const }
  })
  handle(ctx, 'browser.setOccluded', ({ occluded }) => ({ visible: host.setOccluded(occluded) }))
  handle(ctx, 'browser.setHoles', ({ holes }) => {
    host.setHoles(holes)
    return { ok: true as const }
  })
}
