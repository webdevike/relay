import { describe, expect, it, vi, type Mock } from 'vitest'
import type { Session } from 'electron'
import { installTabAppCookies, type TabApps } from './tab-app-cookies'

type Listener = (details: Record<string, unknown>, cb: (r: Record<string, unknown>) => void) => void

function fakeSession() {
  const on: Record<string, { filter: { urls: string[] }; fn: Listener }> = {}
  const webRequest = {
    onBeforeSendHeaders: (filter: { urls: string[] }, fn: Listener) => {
      on.send = { filter, fn }
    },
    onHeadersReceived: (filter: { urls: string[] }, fn: Listener) => {
      on.received = { filter, fn }
    },
  }
  const call = (name: 'send' | 'received', details: Record<string, unknown>) => {
    let out: Record<string, unknown> | undefined
    on[name]!.fn(details, (r) => (out = r))
    return out
  }
  return { ses: { webRequest } as unknown as Pick<Session, 'webRequest'>, on, call }
}

/** Two tabs: webContents 11 shows rbac, 12 follows the partition cookie. */
function fakeTabs(): TabApps & { setSwitchApp: Mock<TabApps['setSwitchApp']> } {
  const apps = new Map<number, string>([[11, 'rbac']])
  const ids = new Map<number, string>([
    [11, 't1'],
    [12, 't2'],
  ])
  return {
    switchAppOfWebContents: (wc) => apps.get(wc),
    tabByWebContents: (wc) => (ids.has(wc) ? { id: ids.get(wc)! } : undefined),
    setSwitchApp: vi.fn(),
  }
}

describe('installTabAppCookies', () => {
  it('listens only to the switch origin, its HMR socket included', () => {
    const { ses, on } = fakeSession()
    installTabAppCookies(ses, fakeTabs())
    const urls = ['https://localhost:3001/*', 'wss://localhost:3001/*']
    expect(on.send!.filter.urls).toEqual(urls)
    expect(on.received!.filter.urls).toEqual(urls)
  })

  it("sends each tab's own ecard_app and keeps the login cookies", () => {
    const { ses, call } = fakeSession()
    installTabAppCookies(ses, fakeTabs())
    const out = call('send', {
      webContentsId: 11,
      requestHeaders: { Accept: '*/*', cookie: 'auth=1; ecard_app=assets' },
    })
    expect(out).toEqual({ requestHeaders: { Accept: '*/*', Cookie: 'auth=1; ecard_app=rbac' } })
    expect(call('send', { webContentsId: 11, requestHeaders: {} })).toEqual({
      requestHeaders: { Cookie: 'ecard_app=rbac' },
    })
  })

  it("leaves requests of tabs without an app, and of no tab (main's fetch), alone", () => {
    const { ses, call } = fakeSession()
    installTabAppCookies(ses, fakeTabs())
    const requestHeaders = { Cookie: 'ecard_app=assets' }
    expect(call('send', { webContentsId: 12, requestHeaders })).toEqual({})
    expect(call('send', { requestHeaders })).toEqual({})
  })

  it("an ecard_app the switch sets in a tab's response becomes that tab's app, not the jar's", () => {
    const { ses, call } = fakeSession()
    const tabs = fakeTabs()
    installTabAppCookies(ses, tabs)
    const out = call('received', {
      webContentsId: 12,
      responseHeaders: {
        Location: ['/'],
        'set-cookie': ['ecard_app=eng6528; Path=/; Max-Age=31536000; SameSite=Lax; Secure', 's=1'],
      },
    })
    expect(tabs.setSwitchApp).toHaveBeenCalledWith('t2', 'eng6528', false)
    expect(out).toEqual({ responseHeaders: { Location: ['/'], 'set-cookie': ['s=1'] } })
    const only = call('received', {
      webContentsId: 11,
      responseHeaders: { 'Set-Cookie': ['ecard_app=assets; Path=/'] },
    })
    expect(only).toEqual({ responseHeaders: {} })
  })

  it("passes other responses, and main's own, through untouched", () => {
    const { ses, call } = fakeSession()
    const tabs = fakeTabs()
    installTabAppCookies(ses, tabs)
    expect(
      call('received', { webContentsId: 11, responseHeaders: { 'set-cookie': ['s=1'] } }),
    ).toEqual({})
    expect(call('received', { webContentsId: 11, responseHeaders: { Vary: ['origin'] } })).toEqual(
      {},
    )
    expect(call('received', { responseHeaders: { 'set-cookie': ['ecard_app=x'] } })).toEqual({})
    expect(tabs.setSwitchApp).not.toHaveBeenCalled()
  })
})
