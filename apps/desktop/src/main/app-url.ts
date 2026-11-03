import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

const rendererDir = path.join(__dirname, '../renderer')

/**
 * Exact match against the app's own renderer origin (dev server) or its built directory.
 * Prefix checks end at a separator: `http://localhost:5173.evil.example` and
 * `file:///.../out/renderer-other/x.html` must not pass, because this is the sender check
 * for every IPC handler and the shell's `will-navigate` guard.
 */
export function matchesAppUrl(
  url: string | undefined,
  opts: { devServerUrl: string | undefined; rendererDir: string },
): boolean {
  if (!url) return false
  if (opts.devServerUrl) {
    let origin: string
    try {
      origin = new URL(opts.devServerUrl).origin
    } catch {
      return false
    }
    return url === origin || url.startsWith(origin + '/')
  }
  const base = pathToFileURL(opts.rendererDir).href.replace(/\/+$/, '') + '/'
  return url.startsWith(base)
}

/** True when `url` belongs to the app's own renderer (dev server or built file). */
export function isAppUrl(url: string | undefined): boolean {
  return matchesAppUrl(url, { devServerUrl: process.env.ELECTRON_RENDERER_URL, rendererDir })
}
