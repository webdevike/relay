import { useEffect, type RefObject } from 'react'
import { invoke } from '../ipc'
import { LAYOUT_EVENT } from '../tiling/layout-event'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Observes `el` and reports its integer rect at most once per animation frame, only when changed. */
export function createSlotSync(el: HTMLElement, send: (r: Rect) => void): () => void {
  let frame = 0
  let last = ''
  const flush = (): void => {
    frame = 0
    const b = el.getBoundingClientRect()
    const r = {
      x: Math.max(0, Math.round(b.x)),
      y: Math.max(0, Math.round(b.y)),
      width: Math.max(0, Math.round(b.width)),
      height: Math.max(0, Math.round(b.height)),
    }
    const key = `${r.x},${r.y},${r.width},${r.height}`
    if (key === last) return
    last = key
    send(r)
  }
  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(flush)
  }
  const ro = new ResizeObserver(schedule)
  ro.observe(el)
  window.addEventListener('resize', schedule)
  // Panes move without resizing (a split beside them, a tab moved to another pane).
  window.addEventListener(LAYOUT_EVENT, schedule)
  // A shell slide moves the slot without resizing it, which ResizeObserver never reports:
  // follow the rect every frame while a shell column is transitioning.
  // Capped, in case a column is hidden mid-slide and its transitionend never arrives.
  let moving = 0
  let follow = 0
  let stopAt = 0
  const track = (): void => {
    flush()
    if (moving > 0 && performance.now() > stopAt) moving = 0
    follow = moving > 0 ? requestAnimationFrame(track) : 0
  }
  const isShellColumn = (e: Event): boolean =>
    e.target instanceof Element && e.target.matches('.eva-sidebar, .eva-tiling')
  const onRun = (e: Event): void => {
    if (!isShellColumn(e)) return
    moving += 1
    stopAt = performance.now() + 1000
    if (!follow) follow = requestAnimationFrame(track)
  }
  const onEnd = (e: Event): void => {
    if (!isShellColumn(e)) return
    moving = Math.max(0, moving - 1)
    if (!moving) schedule()
  }
  document.addEventListener('transitionrun', onRun)
  document.addEventListener('transitionend', onEnd)
  document.addEventListener('transitioncancel', onEnd)
  schedule()
  return () => {
    ro.disconnect()
    window.removeEventListener('resize', schedule)
    window.removeEventListener(LAYOUT_EVENT, schedule)
    document.removeEventListener('transitionrun', onRun)
    document.removeEventListener('transitionend', onEnd)
    document.removeEventListener('transitioncancel', onEnd)
    if (frame) cancelAnimationFrame(frame)
    if (follow) cancelAnimationFrame(follow)
  }
}

export function useSlotSync(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    return createSlotSync(el, (r) => {
      void invoke('browser.setSlot', r)
    })
  }, [ref])
}
