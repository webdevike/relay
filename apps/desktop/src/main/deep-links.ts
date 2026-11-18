import { app } from 'electron'
import type { MainContext } from './context'
import { emit, handle } from './ipc/handle'

/** The URL scheme Relay opens: relay://open/<page>/..., relay://assistant/<id>. */
export const RELAY_SCHEME = 'relay'

/** The relay:// link in a command line (Linux hands a clicked link to the app as an argument). */
export function linkInArgv(argv: readonly string[]): string | null {
  return argv.find((a) => a.startsWith(`${RELAY_SCHEME}://`)) ?? null
}

/**
 * relay:// links clicked outside the app (a browser, Mail, a terminal). macOS hands them to the
 * app that registered the scheme (electron-builder `protocols`, Info.plist CFBundleURLTypes) with
 * `open-url`, also when the click launches it, so this listens before `ready`. Linux has no
 * `open-url`: the desktop entry's `x-scheme-handler/relay` starts the app with the link as an
 * argument, so a cold start reads `process.argv` and a click while it runs arrives through
 * `second-instance` (index.ts holds the single-instance lock there). Links that arrive before
 * the page listens wait for `app.pendingLinks`; later ones go out as `app.openLink` and bring
 * the window forward (Isaac clicked a link to Relay).
 *
 * Only the packaged stable app claims the scheme on macOS: Relay Dev and test instances share the
 * bundle id's handler otherwise and would take Isaac's links. On Linux the desktop entry
 * installed with the app claims it.
 */
export function listenForDeepLinks(claim: boolean): { attach(ctx: MainContext): void } {
  const pending: string[] = []
  let ctx: MainContext | null = null
  /** Set once the page asked for what waited: from then on links go out as events. */
  let listening = false
  const focus = (): void => {
    if (ctx === null || ctx.win.isDestroyed()) return
    if (process.platform !== 'darwin' && ctx.win.isMinimized()) ctx.win.restore()
    ctx.win.show()
    ctx.win.focus()
  }
  const receive = (url: string): void => {
    if (!url.startsWith(`${RELAY_SCHEME}://`)) return
    focus()
    if (ctx === null || !listening) pending.push(url)
    else emit(ctx, 'app.openLink', { url })
  }
  app.on('open-url', (event, url) => {
    event.preventDefault()
    receive(url)
  })
  if (process.platform !== 'darwin') {
    const first = linkInArgv(process.argv)
    if (first) pending.push(first)
    // A second launch (a relay:// link, the launcher again) quits and hands its argv here.
    app.on('second-instance', (_event, argv) => {
      const url = linkInArgv(argv)
      if (url) receive(url)
      else focus()
    })
  }
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
