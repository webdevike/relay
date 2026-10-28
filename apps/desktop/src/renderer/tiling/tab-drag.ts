import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { findTab, isChatPane, tabId, type PaneTab, type Side } from '@evaos/shell-core'
import { addOverlay, removeOverlay } from '../overlay/overlay-store'
import { close as closeAppTab } from '../tabs/tabs-store'
import { moveTab, openTab, splitAt, tilingStore } from './tiling-store'

/**
 * Dragging a tab: onto a pane's edge splits that pane with it, onto a tool pane's middle or tab
 * strip joins that pane. A tool tab moves; a page dragged out of the app tab bar leaves it.
 * The browser view hides while a drag runs, so the drop zones over it show.
 */
export type DropZone = 'center' | Side

export interface DropTarget {
  pane: string
  zone: DropZone
  /** Where in the target's tabs it lands (tab strip drops). */
  index?: number
}

export interface DragState {
  /** What is dragged, its title, and the app tab it came from (a page dragged out of the bar). */
  drag: { tab: PaneTab; title: string; fromAppTab: number | null; x: number; y: number } | null
  target: DropTarget | null
}

export const dragStore = createStore<DragState>(() => ({ drag: null, target: null }))

export function useDrag<T>(selector: (s: DragState) => T): T {
  return useStore(dragStore, selector)
}

const START_PX = 5
/** An edge zone is this share of the pane's width or height. */
const EDGE = 0.25
const OVERLAY_ID = 'tab-drag'

/** Which pane and zone the pointer is over. A chat pane takes edges only. */
export function hitTest(x: number, y: number): DropTarget | null {
  // The app tab bar is no drop target: a short drag along it changes nothing.
  if (document.elementFromPoint(x, y)?.closest('[data-testid=tabbar]')) return null
  const frames = document.querySelectorAll<HTMLElement>('[data-pane-id]')
  for (const frame of frames) {
    const r = frame.getBoundingClientRect()
    if (r.width === 0 || x < r.left || x > r.right || y < r.top || y > r.bottom) continue
    const pane = frame.dataset['paneId']!
    const strip = frame.querySelector<HTMLElement>('[data-pane-tabs]')
    const s = strip?.getBoundingClientRect()
    if (strip && s && !isChatPane(pane) && y >= s.top && y <= s.bottom) {
      const tabs = [...strip.querySelectorAll<HTMLElement>('[data-pane-tab]')]
      const index = tabs.filter((t) => {
        const b = t.getBoundingClientRect()
        return b.left + b.width / 2 < x
      }).length
      return { pane, zone: 'center', index }
    }
    const fx = (x - r.left) / r.width
    const fy = (y - r.top) / r.height
    const edges: Array<[Side, number]> = [
      ['left', fx],
      ['right', 1 - fx],
      ['up', fy],
      ['down', 1 - fy],
    ]
    const [side, dist] = edges.reduce((a, b) => (b[1] < a[1] ? b : a))
    if (dist < EDGE || isChatPane(pane)) return { pane, zone: side }
    return { pane, zone: 'center' }
  }
  return null
}

function drop(state: DragState): void {
  const { drag, target } = state
  if (!drag || !target) return
  const { tab } = drag
  const id = tabId(tab)
  const from = findTab(tilingStore.getState().tiling, id)
  if (target.zone !== 'center') splitAt(target.pane, target.zone, tab)
  else if (!from) openTab(tab, target.pane)
  else {
    // A strip slot counts the dragged tab where it was; the move wants its final position.
    const at = from.pane.tabs.findIndex((x) => tabId(x) === id)
    const index =
      target.index !== undefined && from.pane.id === target.pane && at < target.index
        ? target.index - 1
        : target.index
    moveTab(id, target.pane, index)
  }
  if (drag.fromAppTab !== null) closeAppTab(drag.fromAppTab)
}

/**
 * Starts tracking a possible drag from a pointerdown on a tab. Below the start distance it stays
 * a click; past it the drag runs until the pointer is released (drop) or Escape (cancel).
 */
export function startTabDrag(
  e: { clientX: number; clientY: number; pointerId: number; button: number },
  what: { tab: PaneTab; title: string; fromAppTab?: number },
): void {
  if (e.button !== 0) return
  const x0 = e.clientX
  const y0 = e.clientY
  let active = false
  const move = (ev: PointerEvent): void => {
    if (ev.pointerId !== e.pointerId) return
    if (!active) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < START_PX) return
      active = true
      addOverlay(OVERLAY_ID)
      document.body.classList.add('eva-tab-dragging')
    }
    dragStore.setState({
      drag: {
        tab: what.tab,
        title: what.title,
        fromAppTab: what.fromAppTab ?? null,
        x: ev.clientX,
        y: ev.clientY,
      },
      target: hitTest(ev.clientX, ev.clientY),
    })
  }
  const end = (commit: boolean): void => {
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', up, true)
    window.removeEventListener('pointercancel', cancel, true)
    window.removeEventListener('keydown', key, true)
    window.removeEventListener('blur', cancel)
    if (!active) return
    const state = dragStore.getState()
    dragStore.setState({ drag: null, target: null })
    removeOverlay(OVERLAY_ID)
    document.body.classList.remove('eva-tab-dragging')
    if (commit) {
      try {
        drop(state)
      } catch (err) {
        console.warn('tab drop failed', err)
      }
    }
  }
  const up = (ev: PointerEvent): void => {
    if (ev.pointerId !== e.pointerId) return
    if (active) {
      // The click a drag may end with is not a click on the tab under it.
      const swallow = (c: MouseEvent): void => c.stopPropagation()
      window.addEventListener('click', swallow, true)
      setTimeout(() => window.removeEventListener('click', swallow, true), 0)
    }
    end(true)
  }
  const cancel = (): void => end(false)
  const key = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape' || !active) return
    ev.preventDefault()
    ev.stopPropagation()
    end(false)
  }
  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', cancel, true)
  window.addEventListener('keydown', key, true)
  window.addEventListener('blur', cancel)
}
