/**
 * The guest partition's permission policy (BROW-06). Everything is denied except the clipboard:
 * - `clipboard-sanitized-write` on any page, so copy buttons (`navigator.clipboard.writeText`) work.
 *   Chromium grants it to every focused page itself; it can only put text on the clipboard.
 * - `clipboard-read` only on trusted origins (local dev servers, the eCard dev and stage hosts,
 *   tailnet hosts) and only within {@link GESTURE_WINDOW_MS} of a click or key press in that tab,
 *   so a page cannot silently read whatever Isaac last copied.
 * Electron's permission details carry no user-gesture flag, so the host tracks the last input
 * event per guest webContents and passes its age in. Sign-in popups follow the same gesture rule
 * ({@link allowGuestPopup}).
 */

/** Chromium's transient user activation lasts about 5 s; a read must follow input this closely. */
export const GESTURE_WINDOW_MS = 5000

/** Input event types that count as a user gesture (Chromium's activation-triggering input). */
export const GESTURE_INPUT_TYPES: Readonly<Record<string, true>> = {
  mouseDown: true,
  rawKeyDown: true,
  keyDown: true,
  pointerDown: true,
  gestureTap: true,
  touchEnd: true,
}

const LOOPBACK_HOSTS: Readonly<Record<string, true>> = {
  localhost: true,
  '127.0.0.1': true,
  '[::1]': true,
}
/** The eCard hosts the app switch and eCard work load (`work/ecard-app-switch.ts`). */
const ECARD_HOSTS: Readonly<Record<string, true>> = {
  'dev.platform.ecardsystems.com': true,
  'stage.platform.ecardsystems.com': true,
}

/** True for origins allowed to read the clipboard: loopback, the eCard dev/stage hosts, the tailnet. */
export function isClipboardReadTrusted(url: string | undefined): boolean {
  if (!url) return false
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (Object.hasOwn(LOOPBACK_HOSTS, u.hostname)) return true
  if (u.hostname.endsWith('.ts.net')) return true
  return u.protocol === 'https:' && Object.hasOwn(ECARD_HOSTS, u.hostname)
}

/**
 * The decision for one permission request or check. `gestureAgeMs` is the time since the last
 * user input in the requesting tab (`Infinity` when unknown).
 */
export function allowGuestPermission(
  permission: string,
  requestingUrl: string | undefined,
  gestureAgeMs: number,
): boolean {
  if (permission === 'clipboard-sanitized-write') return true
  if (permission === 'clipboard-read') {
    return gestureAgeMs <= GESTURE_WINDOW_MS && isClipboardReadTrusted(requestingUrl)
  }
  return false
}

/**
 * Whether a page's `window.open` with window features (Electron's `new-window` disposition) may
 * open a real popup window. Sign-in buttons (Google, Apple, GitHub, Auth0) open one and talk to it
 * through `window.opener`/`postMessage`, so a tab would break them. Allowed only for http(s) (or
 * `about:blank`, which Auth0-style flows open first and then point at the provider) and only
 * within {@link GESTURE_WINDOW_MS} of a click or key press in the opener; the caller consumes the
 * gesture so one click opens at most one popup.
 */
export function allowGuestPopup(url: string, gestureAgeMs: number): boolean {
  if (gestureAgeMs > GESTURE_WINDOW_MS) return false
  if (url === '' || url === 'about:blank') return true
  try {
    const p = new URL(url).protocol
    return p === 'http:' || p === 'https:'
  } catch {
    return false
  }
}
