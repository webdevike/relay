import { useEffect, useRef, useState } from 'react'
import { SIDEBAR_MAX, SIDEBAR_MIN } from '@evaos/shell-core'
import { useOccludeBrowser } from '../overlay/overlay-store'
import {
  commitSidebarWidth,
  previewSidebarWidth,
  resetSidebarWidth,
  useLayout,
} from './layout-store'

const STEP = 16
const BIG_STEP = 48

/** The sidebar's resize handle (D-05). Panes resize on their own dividers (tiling/Divider). */
export function Grip() {
  const width = useLayout((s) => s.sidebarPx)
  const widthRef = useRef(width)
  widthRef.current = width
  const [dragging, setDragging] = useState(false)
  const finishDrag = useRef<((updateState?: boolean) => void) | null>(null)
  useOccludeBrowser(dragging)

  useEffect(() => () => finishDrag.current?.(false), [])

  return (
    <div
      className={`eva-grip eva-grip-sidebar${dragging ? ' is-dragging' : ''}`}
      data-testid="grip-sidebar"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0 || finishDrag.current) return
        e.preventDefault()
        e.currentTarget.focus({ preventScroll: true })
        const target = e.currentTarget
        const pointerId = e.pointerId
        const startX = e.clientX
        const startWidth = widthRef.current
        const previousUserSelect = document.body.style.userSelect
        let frame = 0
        let pending: number | null = null
        const flush = (): void => {
          if (frame) cancelAnimationFrame(frame)
          frame = 0
          if (pending === null) return
          const px = pending
          pending = null
          previewSidebarWidth(px)
        }
        const track = (event: PointerEvent): void => {
          pending = startWidth + event.clientX - startX
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
          commitSidebarWidth()
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
      onDoubleClick={resetSidebarWidth}
      onKeyDown={(e) => {
        if (e.key === 'Home') {
          e.preventDefault()
          resetSidebarWidth()
          return
        }
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        const step = e.shiftKey ? BIG_STEP : STEP
        const dx = e.key === 'ArrowRight' ? step : -step
        previewSidebarWidth(widthRef.current + dx)
        commitSidebarWidth()
      }}
    >
      <span className="eva-grip-bar" />
    </div>
  )
}
