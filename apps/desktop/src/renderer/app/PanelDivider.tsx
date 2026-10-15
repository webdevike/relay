import { useEffect, useState } from 'react'
import { useOccludeBrowser } from '../overlay/overlay-store'

export const PANEL_MIN = 320
export const PANEL_MAX = 960

/** Drag handle left of the browser panel. The native view is hidden while dragging so it cannot eat pointer events. */
export function PanelDivider({
  width,
  max,
  onChange,
}: {
  width: number
  max: number
  onChange: (w: number) => void
}) {
  const [drag, setDrag] = useState<{ startX: number; startW: number } | null>(null)
  useOccludeBrowser(drag !== null)

  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent): void => {
      const w = drag.startW + (drag.startX - e.clientX)
      onChange(Math.round(Math.min(Math.max(w, PANEL_MIN), Math.max(PANEL_MIN, max))))
    }
    const up = (): void => setDrag(null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [drag, max, onChange])

  return (
    <div
      className={`eva-divider${drag ? ' is-dragging' : ''}`}
      data-testid="panel-divider"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        e.preventDefault()
        setDrag({ startX: e.clientX, startW: width })
      }}
    />
  )
}
