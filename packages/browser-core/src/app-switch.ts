/**
 * The local eCard app switch (Eva's `work/ecard-app-switch.ts`): one origin that proxies to whichever
 * reports-app worktree its `ecard_app` cookie picks, with `GET /__apps` and `POST /__switch`.
 */
export const APP_SWITCH_ORIGIN = 'https://localhost:3001'

/**
 * True when `url` is a page served through the app switch, so the browser shows its app menu. Tab
 * URLs come from Chromium already normalized, so a prefix match on the origin is exact.
 */
export function isAppSwitchUrl(url: string | undefined): boolean {
  if (!url?.startsWith(APP_SWITCH_ORIGIN)) return false
  const next = url.charAt(APP_SWITCH_ORIGIN.length)
  return next === '' || next === '/' || next === '?' || next === '#'
}
