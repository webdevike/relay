import { invoke } from '../ipc'
import { revealTool } from '../tiling/tiling-store'

/** Web links open in a new tab of the current scope's browser; other schemes go nowhere. */
export function openLink(href: string): void {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return
  revealTool('browser')
  void invoke('browser.createTab', { url: url.href })
}
