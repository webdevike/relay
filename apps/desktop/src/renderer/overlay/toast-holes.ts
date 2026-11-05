import { invoke } from '../ipc'

/** Class of the one `<Notifications>` host (main.tsx); every toast is a child of it. */
export const TOAST_HOST_CLASS = 'eva-toasts'
/** What Mantine puts on each toast. */
const TOAST_SELECTOR = `.${TOAST_HOST_CLASS} .mantine-Notifications-notification`
/** Room for the toast's shadow, so the page never touches it. */
const MARGIN = 8

export interface Hole {
  x: number
  y: number
  width: number
  height: number
}

/** The rect of each on-screen toast, padded and rounded to whole pixels. */
export function toastHoles(root: ParentNode = document): Hole[] {
  const holes: Hole[] = []
  for (const el of root.querySelectorAll(TOAST_SELECTOR)) {
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    const x = Math.max(0, Math.floor(r.left) - MARGIN)
    const y = Math.max(0, Math.floor(r.top) - MARGIN)
    holes.push({
      x,
      y,
      width: Math.ceil(r.right) + MARGIN - x,
      height: Math.ceil(r.bottom) + MARGIN - y,
    })
  }
  return holes
}

/**
 * Tells main where the toasts are, so the native browser views (which paint over the page) leave
 * those rects free instead of covering them. A toast moves while it slides in, out and restacks,
 * so while any exists the rects are read every frame and sent only when they change; with none,
 * nothing runs but a DOM observer waiting for the first.
 */
export function startToastHoles(): () => void {
  let last = ''
  let frame = 0
  const send = (holes: Hole[]): void => {
    const key = JSON.stringify(holes)
    if (key === last) return
    last = key
    void invoke('browser.setHoles', { holes: holes.slice(0, 16) })
  }
  const tick = (): void => {
    frame = 0
    const holes = toastHoles()
    send(holes)
    if (holes.length > 0) frame = requestAnimationFrame(tick)
  }
  const kick = (): void => {
    if (frame === 0) frame = requestAnimationFrame(tick)
  }
  const observer = new MutationObserver(kick)
  observer.observe(document.body, { childList: true, subtree: true })
  window.addEventListener('resize', kick)
  kick()
  return () => {
    observer.disconnect()
    window.removeEventListener('resize', kick)
    if (frame !== 0) cancelAnimationFrame(frame)
  }
}
