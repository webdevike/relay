import { normalize } from '@evaos/browser-core/address'
import type { MainContext } from '../context'
import { handle } from '../ipc/handle'
import type { BrowserHost } from './browser-host'

export function registerBrowserIpc(ctx: MainContext, host: BrowserHost): void {
  handle(ctx, 'browser.state', () => host.snapshot())
  handle(ctx, 'browser.navigate', ({ tabId, input }) => {
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
  handle(ctx, 'browser.setSlot', (rect) => {
    host.setSlot(rect)
    return { ok: true as const }
  })
  handle(ctx, 'browser.setOccluded', ({ occluded }) => ({ visible: host.setOccluded(occluded) }))
}
