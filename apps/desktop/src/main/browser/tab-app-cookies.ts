import type { Session } from 'electron'
import {
  APP_SWITCH_URL_PATTERNS,
  switchAppFromSetCookie,
  withSwitchAppCookie,
} from '@evaos/browser-core/app-switch'

/** What the cookie rewrite needs from the browser host. */
export interface TabApps {
  switchAppOfWebContents(wcId: number): string | undefined
  tabByWebContents(wcId: number): { id: string } | undefined
  setSwitchApp(tabId: string, app: string, reload?: boolean): void
}

/**
 * Per-tab eCard apps on one origin. Every tab shares the partition's cookie jar (and so Isaac's
 * login), but each request a tab makes to the app switch, its HMR socket included, carries that
 * tab's own `ecard_app`. An `ecard_app` the switch sets in a tab's response (an `/__app/<name>`
 * link) becomes that tab's app instead of landing in the shared jar. Requests from no tab (main's
 * own `/__apps` fetch) are left alone. These are the partition's only header listeners.
 */
export function installTabAppCookies(ses: Pick<Session, 'webRequest'>, tabs: TabApps): void {
  const filter = { urls: APP_SWITCH_URL_PATTERNS }
  ses.webRequest.onBeforeSendHeaders(filter, (details, cb) => {
    const app =
      details.webContentsId === undefined
        ? undefined
        : tabs.switchAppOfWebContents(details.webContentsId)
    if (!app) return cb({})
    const requestHeaders = { ...details.requestHeaders }
    const key = Object.keys(requestHeaders).find((k) => k.toLowerCase() === 'cookie')
    const cookie = withSwitchAppCookie(key ? requestHeaders[key] : undefined, app)
    if (key) delete requestHeaders[key]
    requestHeaders.Cookie = cookie
    cb({ requestHeaders })
  })
  ses.webRequest.onHeadersReceived(filter, (details, cb) => {
    const tab =
      details.webContentsId === undefined ? undefined : tabs.tabByWebContents(details.webContentsId)
    const responseHeaders = details.responseHeaders
    const key =
      responseHeaders && Object.keys(responseHeaders).find((k) => k.toLowerCase() === 'set-cookie')
    if (!tab || !responseHeaders || !key) return cb({})
    const { app, rest } = switchAppFromSetCookie(responseHeaders[key] ?? [])
    if (!app) return cb({})
    // The redirect that follows already carries the new app, so the tab is not reloaded again.
    tabs.setSwitchApp(tab.id, app, false)
    const out = { ...responseHeaders }
    if (rest.length) out[key] = rest
    else delete out[key]
    cb({ responseHeaders: out })
  })
}
