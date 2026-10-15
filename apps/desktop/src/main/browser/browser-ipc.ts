import { normalize } from '@evaos/browser-core/address'
import type { MainContext } from '../context'
import { handle } from '../ipc/handle'
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
    return host.createTab(url ? (normalize(url) ?? undefined) : undefined, true)
  })
  handle(ctx, 'browser.closeTab', ({ tabId }) => ({ activeId: host.closeTab(tabId) }))
  handle(ctx, 'browser.activateTab', ({ tabId }) => ({ activeId: host.activateTab(tabId) }))
  handle(ctx, 'browser.suggest', ({ text }) => ({ items: host.history.suggest(text) }))
  handle(ctx, 'browser.openDevTools', ({ tabId }) => {
    host.openDevTools(tabId)
    return { ok: true as const }
  })
  handle(ctx, 'browser.extensions', () => ({ extensions: listExtensions() }))
  handle(ctx, 'browser.setSlot', (rect) => {
    host.setSlot(rect)
    return { ok: true as const }
  })
  handle(ctx, 'browser.setOccluded', ({ occluded }) => ({ visible: host.setOccluded(occluded) }))
}
