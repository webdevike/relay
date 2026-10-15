import { useEffect, useRef, useState } from 'react'
import { PANEL_MIN, SIDEBAR_MAX, SIDEBAR_MIN } from '@evaos/shell-core'
import { useOccludeBrowser } from '../overlay/overlay-store'
import { commitWidth, previewWidth, resetWidth, useLayout, type Edge } from './layout-store'

const STEP = 16
const BIG_STEP = 48

/** Edge resize handle (D-05). The panel grows leftward, so its dx is negated. */
export function Grip({ edge }: { edge: Edge }) {
  const width = useLayout((s) => (edge === 'sidebar' ? s.sidebarPx : s.panelPx))
  const widthRef = useRef(width)
  widthRef.current = width
  const [dragging, setDragging] = useState(false)
  const start = useRef({ x: 0, w: 0 })
  useOccludeBrowser(dragging)

  useEffect(() => {
    if (!dragging) return
    let frame = 0
    let pending: number | null = null
    const sign = edge === 'sidebar' ? 1 : -1
    const flush = (): void => {
      frame = 0
      if (pending === null) return
      const px = pending
      pending = null
      previewWidth(edge, px)
    }
    const move = (e: PointerEvent): void => {
      pending = start.current.w + sign * (e.clientX - start.current.x)
      if (!frame) frame = requestAnimationFrame(flush)
    }
    const up = (): void => {
      if (frame) cancelAnimationFrame(frame)
      flush()
      document.body.style.userSelect = ''
      document.body.classList.remove('eva-resizing')
      setDragging(false)
      commitWidth(edge)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      // Also covers unmounting mid-drag (e.g. Cmd+B hides the sidebar).
      document.body.style.userSelect = ''
      document.body.classList.remove('eva-resizing')
    }
  }, [dragging, edge])

  const label = edge === 'sidebar' ? 'Resize sidebar' : 'Resize panel'
  return (
    <div
      className={`eva-grip eva-grip-${edge}${dragging ? ' is-dragging' : ''}`}
      data-testid={`grip-${edge}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={edge === 'sidebar' ? SIDEBAR_MIN : PANEL_MIN}
      aria-valuemax={edge === 'sidebar' ? SIDEBAR_MAX : undefined}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        start.current = { x: e.clientX, w: widthRef.current }
        document.body.style.userSelect = 'none'
        document.body.classList.add('eva-resizing')
        setDragging(true)
      }}
      onDoubleClick={() => resetWidth(edge)}
      onKeyDown={(e) => {
        if (e.key === 'Home') {
          e.preventDefault()
          resetWidth(edge)
          return
        }
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        const step = e.shiftKey ? BIG_STEP : STEP
        const dx = e.key === 'ArrowRight' ? step : -step
        previewWidth(edge, widthRef.current + (edge === 'sidebar' ? dx : -dx))
        commitWidth(edge)
      }}
    >
      <span className="eva-grip-bar" />
    </div>
  )
}
