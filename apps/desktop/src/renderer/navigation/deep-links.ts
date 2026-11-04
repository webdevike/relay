import { invoke, on } from '../ipc'
import { openAppLink } from './open-link'

/**
 * relay:// links clicked outside the app (main/deep-links.ts): the ones that launched it, then each
 * one as it comes. They open in the app tab in front, as a click on a link to Relay should.
 */
export function startDeepLinks(): () => void {
  void invoke('app.pendingLinks', {}).then((r) => {
    if (r.ok) for (const url of r.value.urls) openAppLink(url, 'here')
  })
  return on('app.openLink', ({ url }) => void openAppLink(url, 'here'))
}
