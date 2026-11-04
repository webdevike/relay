import { app } from 'electron'
import type { MainContext } from './context'
import { emit, handle } from './ipc/handle'

/** The URL scheme Relay opens: relay://open/<page>/..., relay://assistant/<id>. */
export const RELAY_SCHEME = 'relay'

/**
 * relay:// links clicked outside the app (a browser, Mail, a terminal). macOS hands them to the
 * app that registered the scheme (electron-builder `protocols`, Info.plist CFBundleURLTypes) with
 * `open-url`, also when the click launches it, so this listens before `ready`. Links that arrive
 * before the page listens wait for `app.pendingLinks`; later ones go out as `app.openLink` and
 * bring the window forward (Isaac clicked a link to Relay).
 *
 * Only the packaged stable app claims the scheme: Relay Dev and test instances share the bundle
 * id's handler otherwise and would take Isaac's links.
 */
export function listenForDeepLinks(claim: boolean): { attach(ctx: MainContext): void } {
  const pending: string[] = []
  let ctx: MainContext | null = null
  /** Set once the page asked for what waited: from then on links go out as events. */
  let listening = false
  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (!url.startsWith(`${RELAY_SCHEME}://`)) return
    if (ctx !== null && !ctx.win.isDestroyed()) {
      ctx.win.show()
      ctx.win.focus()
    }
    if (ctx === null || !listening) pending.push(url)
    else emit(ctx, 'app.openLink', { url })
  })
  if (claim && !app.isDefaultProtocolClient(RELAY_SCHEME)) {
    app.setAsDefaultProtocolClient(RELAY_SCHEME)
  }
  return {
    attach(c) {
      ctx = c
      handle(c, 'app.pendingLinks', () => {
        listening = true
        return { urls: pending.splice(0) }
      })
    },
  }
}
