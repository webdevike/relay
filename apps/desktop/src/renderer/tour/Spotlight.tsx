import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import { clearSpotlight, findTarget, tourStore } from './tour-store'
import './tour.css'

interface Box {
  x: number
  y: number
  width: number
  height: number
}

const PAD = 6
const CAPTION_W = 300

/**
 * tour.highlight's spotlight: the rest of the window dims, the control keeps its light behind a
 * ring, and the agent's caption sits under it (above when there is no room). Clicks pass through
 * to the app; any click, Escape or the timeout ends it. The control is found again every frame,
 * so it follows scrolling and resizing.
 */
export function Spotlight() {
  const spot = useStore(tourStore, (s) => s.spot)
  const [box, setBox] = useState<Box | null>(null)

  useEffect(() => {
    if (spot === null) {
      setBox(null)
      return
    }
    let frame = 0
    const track = (): void => {
      if (Date.now() > spot.until) {
        clearSpotlight()
        return
      }
      const el = findTarget(spot.target)
      const r = el?.getBoundingClientRect()
      setBox((prev) =>
        r === undefined
          ? null
          : prev &&
              prev.x === r.x &&
              prev.y === r.y &&
              prev.width === r.width &&
              prev.height === r.height
            ? prev
            : { x: r.x, y: r.y, width: r.width, height: r.height },
      )
      frame = requestAnimationFrame(track)
    }
    track()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') clearSpotlight()
    }
    const onDown = (): void => clearSpotlight()
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [spot])

  if (spot === null || box === null) return null
  const ring = {
    left: box.x - PAD,
    top: box.y - PAD,
    width: box.width + PAD * 2,
    height: box.height + PAD * 2,
  }
  const below = ring.top + ring.height + 140 < window.innerHeight
  const left = Math.max(8, Math.min(ring.left, window.innerWidth - CAPTION_W - 8))
  return (
    <div
      className="eva-tour"
      data-testid="tour-spotlight"
      data-target={spot.target}
      aria-live="polite"
    >
      <div className="eva-tour-ring" style={ring} />
      <div
        className="eva-tour-caption"
        role="status"
        data-testid="tour-caption"
        style={
          below
            ? { left, top: ring.top + ring.height + 10, width: CAPTION_W }
            : { left, bottom: window.innerHeight - ring.top + 10, width: CAPTION_W }
        }
      >
        {spot.title ? <div className="eva-tour-title">{spot.title}</div> : null}
        <div className="eva-tour-text">{spot.caption}</div>
        {spot.step ? (
          <div className="eva-tour-step">
            Step {spot.step.n} of {spot.step.of}
          </div>
        ) : null}
      </div>
    </div>
  )
}
