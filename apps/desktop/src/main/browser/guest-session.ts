import * as path from 'node:path'
import { app, session, type WebContents } from 'electron'
import type { Env } from '../env'
import { allowGuestPermission, GESTURE_INPUT_TYPES } from './guest-permissions'

export const GUEST_PARTITION = 'persist:browser'

// Last user input per guest webContents (tabs and their sign-in popups): Electron's permission
// and window-open details carry no gesture flag.
const gestures = new WeakMap<WebContents, number>()

/** Milliseconds since the last click or key press in `wc`; Infinity when there was none. */
export function gestureAge(wc: WebContents | null): number {
  const at = wc ? gestures.get(wc) : undefined
  return at === undefined ? Infinity : Date.now() - at
}

/** Uses up `wc`'s gesture, as Chromium's popup blocker does: one click opens one popup. */
export function consumeGesture(wc: WebContents): void {
  gestures.delete(wc)
}

/** Hardens the guest partition only; the shell session is never touched. */
export function setupGuestSession(env: Env): void {
  const ses = session.fromPartition(GUEST_PARTITION)

  app.on('web-contents-created', (_e, wc) => {
    if (wc.session !== ses) return
    wc.on('input-event', (_ev, input) => {
      if (Object.hasOwn(GESTURE_INPUT_TYPES, input.type)) gestures.set(wc, Date.now())
    })
  })

  // The user agent stays Electron's own (`... Relay/<v> Chrome/<v> Electron/<v> ...`). Measured
  // 2026-11-04 on Google sign-in from vercel.com: that one reaches the password step, while a stock
  // Chrome user agent (reduced or full version, even with Google Chrome client-hint brands) is
  // refused with "This browser or app may not be secure". Google rejects a browser that claims to
  // be Chrome without being it, not an honest embedded one.

  // Tells the host when a page asks for a passkey, which this browser can't offer, and holds
  // Design Mode's pointer gate in the top frame (preload/guest.ts).
  ses.registerPreloadScript({
    id: 'relay-passkey-watch',
    type: 'frame',
    filePath: path.join(__dirname, '../preload/guest.js'),
  })

  // Deny all but the clipboard (BROW-06, A6): see guest-permissions.ts.
  ses.setPermissionRequestHandler((wc, permission, cb, details) =>
    cb(allowGuestPermission(permission, details.requestingUrl, gestureAge(wc))),
  )
  ses.setPermissionCheckHandler((wc, permission, origin, details) =>
    allowGuestPermission(permission, details.requestingUrl ?? origin, gestureAge(wc)),
  )
  ses.setDevicePermissionHandler(() => false)

  if (env.e2e && process.env.EVAOS_E2E_NETWORK !== '1') {
    ses.webRequest.onBeforeRequest((details, cb) => {
      let cancel = false
      try {
        const u = new URL(details.url)
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          cancel = u.hostname !== '127.0.0.1' && u.hostname !== 'localhost'
        }
      } catch {
        /* not a URL: let it through */
      }
      cb({ cancel })
    })
  }
}
