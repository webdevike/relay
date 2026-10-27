/**
 * The local eCard app switch (Eva's `work/ecard-app-switch.ts`): one origin that proxies to whichever
 * reports-app worktree its `ecard_app` cookie picks, with `GET /__apps` and `POST /__switch`.
 */
export const APP_SWITCH_ORIGIN = 'https://localhost:3001'
export const APP_SWITCH_COOKIE = 'ecard_app'

/** Every request a page on the switch makes to it: documents, modules, fetches and the HMR socket. */
export const APP_SWITCH_URL_PATTERNS = [`${APP_SWITCH_ORIGIN}/*`, 'wss://localhost:3001/*']

/**
 * True when `url` is a page served through the app switch, so the browser shows its app menu. Tab
 * URLs come from Chromium already normalized, so a prefix match on the origin is exact.
 */
export function isAppSwitchUrl(url: string | undefined): boolean {
  if (!url?.startsWith(APP_SWITCH_ORIGIN)) return false
  const next = url.charAt(APP_SWITCH_ORIGIN.length)
  return next === '' || next === '/' || next === '?' || next === '#'
}

/** A request's Cookie header with `ecard_app` set to `app`, whatever the partition's jar sent. */
export function withSwitchAppCookie(header: string | undefined, app: string): string {
  const others = (header ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p !== '' && p.split('=', 1)[0]!.trim() !== APP_SWITCH_COOKIE)
  return [...others, `${APP_SWITCH_COOKIE}=${app}`].join('; ')
}

/**
 * Splits a response's Set-Cookie values into the app an `ecard_app` cookie names (the switch's
 * `/__app/<name>` and `/__switch`) and the rest, which pass through untouched.
 */
export function switchAppFromSetCookie(values: readonly string[]): {
  app: string | null
  rest: string[]
} {
  let app: string | null = null
  const rest: string[] = []
  for (const v of values) {
    const m = new RegExp(`^\\s*${APP_SWITCH_COOKIE}=([\\w-]{1,64})\\s*(?:;|$)`).exec(v)
    if (m) app = m[1]!
    else rest.push(v)
  }
  return { app, rest }
}
