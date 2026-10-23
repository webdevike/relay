import { invoke } from '../ipc'
import { togglePanel } from '../shell/layout-store'

/** Web links open in a new tab of the panel's browser; other schemes go nowhere. */
export function openLink(href: string): void {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return
  togglePanel(true)
  void invoke('browser.createTab', { url: url.href })
}
