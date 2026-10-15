import { session } from 'electron'
import type { Env } from '../env'

export const GUEST_PARTITION = 'persist:browser'

/** Hardens the guest partition only; the shell session is never touched. */
export function setupGuestSession(env: Env): void {
  const ses = session.fromPartition(GUEST_PARTITION)
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
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
