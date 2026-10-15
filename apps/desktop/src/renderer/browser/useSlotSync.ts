import { useEffect, type RefObject } from 'react'
import { invoke } from '../ipc'

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
  schedule()
  return () => {
    ro.disconnect()
    window.removeEventListener('resize', schedule)
    if (frame) cancelAnimationFrame(frame)
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
