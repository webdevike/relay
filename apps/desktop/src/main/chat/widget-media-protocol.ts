import { protocol } from 'electron'
import * as os from 'node:os'
import * as path from 'node:path'
import type { MainContext } from '../context'
import { relayConfigDir, servePort } from '../relay/device'
import { handleMediaRequest } from './widget-media'

const SCHEME = 'relay-media'

/**
 * Must run before the app is ready: media elements and fetch only stream from privileged schemes,
 * and the file:// renderer fetches models (three's GLTFLoader) cross-origin, so CORS is on.
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ])
}

/**
 * Serves widget media (`relay-media://media/?src=<src>`). Live: the cache and Relay's port live
 * in Relay's config dir. Fixtures and e2e use `<configDir>/relay` so a test never touches it.
 */
export function registerWidgetMedia(ctx: MainContext): void {
  const relayDir = ctx.env.live
    ? relayConfigDir(process.env, os.homedir())
    : path.join(ctx.env.configDir, 'relay')
  const deps = {
    cacheDir: path.join(relayDir, 'widget-media'),
    servePort: () => servePort(relayDir),
    home: os.homedir(),
  }
  protocol.handle(SCHEME, (request) => handleMediaRequest(request, deps))
}
