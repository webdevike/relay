import { app, session, type WebContents } from 'electron'
import type { Env } from '../env'
import { allowGuestPermission, GESTURE_INPUT_TYPES } from './guest-permissions'

export const GUEST_PARTITION = 'persist:browser'

/** Hardens the guest partition only; the shell session is never touched. */
export function setupGuestSession(env: Env): void {
  const ses = session.fromPartition(GUEST_PARTITION)

  // Last user input per guest webContents: Electron's permission details carry no gesture flag.
  const gestures = new WeakMap<WebContents, number>()
  app.on('web-contents-created', (_e, wc) => {
    if (wc.session !== ses) return
    wc.on('input-event', (_ev, input) => {
      if (Object.hasOwn(GESTURE_INPUT_TYPES, input.type)) gestures.set(wc, Date.now())
    })
  })
  const gestureAge = (wc: WebContents | null): number => {
    const at = wc ? gestures.get(wc) : undefined
    return at === undefined ? Infinity : Date.now() - at
  }

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
