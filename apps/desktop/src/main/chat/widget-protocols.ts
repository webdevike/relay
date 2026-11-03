import { protocol } from 'electron'
import * as os from 'node:os'
import * as path from 'node:path'
import type { MainContext } from '../context'
import { relayConfigDir, servePort } from '../relay/device'
import { FRAME_SCHEME, handleFrameRequest } from './widget-frame'
import { handleMediaRequest } from './widget-media'
import { REVIEWS_MEDIA_DIR } from '../reviews/review-media'

const MEDIA_SCHEME = 'relay-media'

/**
 * Must run before the app is ready, and only once: Electron takes every privileged scheme in one
 * call. Media elements and fetch only stream from privileged schemes, and the file:// renderer
 * fetches models (three's GLTFLoader) cross-origin, so CORS is on. Widget pages are standard
 * (host and path parse) and secure, nothing more: they run sandboxed with an opaque origin.
 */
export function registerWidgetSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
    { scheme: FRAME_SCHEME, privileges: { standard: true, secure: true } },
  ])
}

/**
 * Serves widget media (`relay-media://media/?src=<src>`). The cache and the port live in the config
 * dir of the Relay this app connects to (EVAOS_RELAY_DIR, live: Relay's own). Fixtures and e2e
 * without one use `<configDir>/relay` so a test never touches it.
 */
export function registerWidgetMedia(ctx: MainContext): void {
  const relayDir =
    ctx.env.relayDir ??
    (ctx.env.live
      ? relayConfigDir(process.env, os.homedir())
      : path.join(ctx.env.configDir, 'relay'))
  const deps = {
    cacheDir: path.join(relayDir, 'widget-media'),
    servePort: () => servePort(relayDir),
    home: os.homedir(),
    reviewsDir: path.join(ctx.env.configDir, REVIEWS_MEDIA_DIR),
  }
  protocol.handle(MEDIA_SCHEME, (request) => handleMediaRequest(request, deps))
}

/** Serves agent-made widget pages (`relay-widget://frame/<runtime>?...`, see widget-frame.ts). */
export function registerWidgetFrames(): void {
  protocol.handle(FRAME_SCHEME, handleFrameRequest)
}
