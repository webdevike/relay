import { on } from '../ipc'

/**
 * Whether portraits may animate right now, and a signal when that changes. Motion is off with the
 * app's motion setting (`html[data-eva-motion='off']`, which tests and EVAOS_NO_MOTION set) or the
 * system's reduced motion. Nothing animates while the page cannot be seen: the document is hidden,
 * or main says the window is hidden or minimized (`app.windowShown`; background throttling is off,
 * so the document alone never reads hidden). Then `html[data-eva-page-hidden='true']` pauses the
 * portraits' CSS animations too.
 */
const REDUCED = '(prefers-reduced-motion: reduce)'

/** The app or the system asks for no motion. */
export function motionOff(): boolean {
  if (document.documentElement.dataset['evaMotion'] === 'off') return true
  return window.matchMedia?.(REDUCED).matches ?? false
}

let windowShown = true
let watchingWindow = false

/** Nothing of the page can be seen. */
export function pageHidden(): boolean {
  return document.hidden || !windowShown
}

/** Portraits animate: motion is on and the page shows. */
export function motionLive(): boolean {
  return !pageHidden() && !motionOff()
}

const listeners = new Set<() => void>()
let stop: (() => void) | null = null

function changed(): void {
  document.documentElement.dataset['evaPageHidden'] = pageHidden() ? 'true' : 'false'
  for (const l of [...listeners]) l()
}

function start(): () => void {
  // Kept for the app's life, so the window's state is known whenever a portrait mounts.
  if (!watchingWindow) {
    watchingWindow = true
    on('app.windowShown', (p) => {
      windowShown = p.shown
      changed()
    })
  }
  changed()
  document.addEventListener('visibilitychange', changed)
  const mql = window.matchMedia?.(REDUCED)
  mql?.addEventListener('change', changed)
  const observer = new MutationObserver(changed)
  observer.observe(document.documentElement, { attributeFilter: ['data-eva-motion'] })
  return () => {
    document.removeEventListener('visibilitychange', changed)
    mql?.removeEventListener('change', changed)
    observer.disconnect()
  }
}

/** Calls `cb` whenever `motionLive()` may have changed; returns the unsubscribe. */
export function onMotionGate(cb: () => void): () => void {
  stop ??= start()
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0 && stop) {
      stop()
      stop = null
    }
  }
}
