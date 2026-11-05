import { invoke, on } from '../ipc'
import { startCopyLink } from './copy-link'
import { openAppLink } from './open-link'

/**
 * relay:// links clicked outside the app (main/deep-links.ts): the ones that launched it, then each
 * one as it comes. They open here, in the workspace on screen and focused, like a plain click.
 * Also binds Cmd+Shift+C, which copies the focused tab's relay:// link.
 */
export function startDeepLinks(): () => void {
  void invoke('app.pendingLinks', {}).then((r) => {
    if (r.ok) for (const url of r.value.urls) openAppLink(url, 'here')
  })
  const offLinks = on('app.openLink', ({ url }) => void openAppLink(url, 'here'))
  const offCopy = startCopyLink()
  return () => {
    offLinks()
    offCopy()
  }
}
