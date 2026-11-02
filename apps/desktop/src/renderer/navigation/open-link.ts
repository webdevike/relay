import { resolveLink } from '@evaos/contract'
import { invoke } from '../ipc'
import { revealTool } from '../tiling/tiling-store'
import { linkPrefsStore } from './link-prefs'

/**
 * Opens a web link where Settings > Links says: a new tab of the current scope's browser, or (an
 * app, a URL scheme, the default browser) through main. Other schemes go nowhere.
 */
export function openLink(href: string): void {
  const { prefs, apps } = linkPrefsStore.getState()
  const route = resolveLink(prefs, href, (app) => apps.includes(app))
  if (route.to === 'none') return
  if (route.to === 'browser') {
    revealTool('browser')
    void invoke('browser.createTab', { url: route.url })
    return
  }
  void invoke('links.open', { url: new URL(href).href })
}
