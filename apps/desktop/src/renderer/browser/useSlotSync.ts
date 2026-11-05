import { useEffect, type RefObject } from 'react'
import { invoke } from '../ipc'
import { LAYOUT_EVENT } from '../tiling/layout-event'

/** One page view on screen: its page and its rect, in window content coordinates. */
export interface PageSlot {
  tabId: string
  x: number
  y: number
  width: number
  height: number
}

export interface Slots {
  /** Puts page `tabId`'s view over `el` until the returned function takes it off screen. */
  add(tabId: string, el: HTMLElement): () => void
  dispose(): void
}

/**
 * Every page tab on screen, measured together: each visible page's slot element, as integer rects,
 * goes to `send` as one list (the host shows exactly those views, every other one parks), at
 * most once per animation frame and only when something changed.
 */
export function createSlots(send: (slots: PageSlot[]) => void): Slots {
  const els = new Map<string, HTMLElement>()
  let frame = 0
  let last = ''
  const flush = (): void => {
    frame = 0
    const slots: PageSlot[] = []
    for (const [tabId, el] of els) {
      const b = el.getBoundingClientRect()
      const slot = {
        tabId,
        x: Math.max(0, Math.round(b.x)),
        y: Math.max(0, Math.round(b.y)),
        width: Math.max(0, Math.round(b.width)),
        height: Math.max(0, Math.round(b.height)),
      }
      if (slot.width > 0 && slot.height > 0) slots.push(slot)
    }
    const key = slots.map((s) => `${s.tabId}:${s.x},${s.y},${s.width},${s.height}`).join(' ')
    if (key === last) return
    last = key
    send(slots)
  }
  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(flush)
  }
  const ro = new ResizeObserver(schedule)
  window.addEventListener('resize', schedule)
  // Panes move without resizing (a split beside them, a tab moved to another pane).
  window.addEventListener(LAYOUT_EVENT, schedule)
  // A shell slide moves the slots without resizing them, which ResizeObserver never reports:
  // follow the rects every frame while a shell column is transitioning.
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
  return {
    add(tabId, el) {
      els.set(tabId, el)
      ro.observe(el)
      schedule()
      return () => {
        if (els.get(tabId) !== el) return
        els.delete(tabId)
        ro.unobserve(el)
        schedule()
      }
    },
    dispose() {
      ro.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener(LAYOUT_EVENT, schedule)
      document.removeEventListener('transitionrun', onRun)
      document.removeEventListener('transitionend', onEnd)
      document.removeEventListener('transitioncancel', onEnd)
      if (frame) cancelAnimationFrame(frame)
      if (follow) cancelAnimationFrame(follow)
      els.clear()
    },
  }
}

let shared: Slots | null = null

/** While `visible`, page `tabId`'s view sits over the element `ref` holds; else it parks. */
export function useWebSlot(
  ref: RefObject<HTMLElement | null>,
  tabId: string,
  visible: boolean,
): void {
  useEffect(() => {
    const el = ref.current
    if (!el || !visible) return
    shared ??= createSlots((slots) => void invoke('browser.setSlots', { slots }))
    return shared.add(tabId, el)
  }, [ref, tabId, visible])
}
