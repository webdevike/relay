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
  const finishDrag = useRef<((updateState?: boolean) => void) | null>(null)
  useOccludeBrowser(dragging)

  useEffect(() => () => finishDrag.current?.(false), [])

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
        if (e.button !== 0 || finishDrag.current) return
        e.preventDefault()
        e.currentTarget.focus({ preventScroll: true })
        const target = e.currentTarget
        const pointerId = e.pointerId
        const startX = e.clientX
        const startWidth = widthRef.current
        const sign = edge === 'sidebar' ? 1 : -1
        const previousUserSelect = document.body.style.userSelect
        let frame = 0
        let pending: number | null = null
        const flush = (): void => {
          if (frame) cancelAnimationFrame(frame)
          frame = 0
          if (pending === null) return
          const px = pending
          pending = null
          previewWidth(edge, px)
        }
        const track = (event: PointerEvent): void => {
          pending = startWidth + sign * (event.clientX - startX)
        }
        const finish = (updateState = true): void => {
          if (!finishDrag.current) return
          finishDrag.current = null
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          window.removeEventListener('pointercancel', cancel)
          window.removeEventListener('blur', blur)
          target.removeEventListener('lostpointercapture', cancel)
          flush()
          if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId)
          document.body.style.userSelect = previousUserSelect
          document.body.classList.remove('eva-resizing')
          commitWidth(edge)
          if (updateState) setDragging(false)
        }
        const move = (event: PointerEvent): void => {
          if (event.pointerId !== pointerId) return
          if (event.buttons === 0) {
            finish()
            return
          }
          track(event)
          if (!frame) frame = requestAnimationFrame(flush)
        }
        const up = (event: PointerEvent): void => {
          if (event.pointerId !== pointerId) return
          track(event)
          finish()
        }
        const cancel = (event: PointerEvent): void => {
          if (event.pointerId === pointerId) finish()
        }
        const blur = (): void => finish()
        finishDrag.current = finish
        // Install synchronously so a fast release cannot arrive before a React effect.
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', cancel)
        window.addEventListener('blur', blur)
        target.addEventListener('lostpointercapture', cancel)
        target.setPointerCapture?.(pointerId)
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
