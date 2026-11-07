import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { StudioItem, StudioJob, StudioSegment } from '@evaos/contract'
import { mediaSrc } from '../library/actions'
import { dragCrop, type CropGrip, type CropRect } from './recipes'

export interface EditorCanvasProps {
  cur: StudioItem
  /** The parent version, for hold-compare and the split slider. */
  before: StudioItem | undefined
  hold: boolean
  split: boolean
  /** 1 fits the canvas. */
  zoom: number
  /** The fitted size over the file's size, measured after layout. */
  onFit: (fit: number) => void
  /** This version's queued or running child job. */
  pending: StudioJob | undefined
  /** Stops the pending job. */
  onCancel: (id: string) => void
  segment: StudioSegment | undefined
  crop: CropRect | null
  onCrop: (rect: CropRect) => void
}

/** The current version, big: zoom and pan, compare with the parent, the generating overlay, the mask box, crop. */
export function EditorCanvas({
  cur,
  before,
  hold,
  split,
  zoom,
  onFit,
  pending,
  onCancel,
  segment,
  crop,
  onCrop,
}: EditorCanvasProps) {
  const media = useRef<HTMLImageElement & HTMLVideoElement>(null)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [panning, setPanning] = useState<{ x: number; y: number; px: number; py: number } | null>(
    null,
  )
  const shown = hold && before ? before : cur
  const video = shown.asset.kind === 'video'

  useEffect(() => {
    if (zoom <= 1) setPan({ x: 0, y: 0 })
  }, [zoom])

  useEffect(() => {
    const el = media.current
    if (!el) return
    const measure = (): void => {
      if (el.clientWidth > 0) onFit(el.clientWidth / shown.asset.width)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [shown.asset.id, shown.asset.width, onFit])

  const canPan = zoom > 1 && crop === null
  const startPan = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!canPan || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setPanning({ x: e.clientX, y: e.clientY, px: pan.x, py: pan.y })
  }
  const movePan = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!panning) return
    setPan({ x: panning.px + e.clientX - panning.x, y: panning.py + e.clientY - panning.y })
  }

  const box = segment?.box
  return (
    <div
      className="ed-canvas"
      data-pan={canPan}
      onPointerDown={startPan}
      onPointerMove={movePan}
      onPointerUp={() => setPanning(null)}
      onPointerCancel={() => setPanning(null)}
    >
      <div
        className="ed-frame"
        data-dragging={panning !== null}
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
      >
        {video ? (
          <video
            key={shown.asset.id}
            ref={media}
            className={`ed-media${pending ? ' blur' : ''}`}
            src={mediaSrc(shown.asset.path)}
            poster={mediaSrc(shown.asset.thumb)}
            controls
            autoPlay
            loop
            onLoadedMetadata={(e) => onFit(e.currentTarget.clientWidth / shown.asset.width)}
            data-testid="studio-ed-media"
            data-id={shown.asset.id}
          />
        ) : (
          <img
            key={shown.asset.id}
            ref={media}
            className={`ed-media${pending ? ' blur' : ''}`}
            src={mediaSrc(shown.asset.path)}
            alt={shown.job.spec.prompt}
            draggable={false}
            onLoad={(e) => onFit(e.currentTarget.clientWidth / shown.asset.width)}
            data-testid="studio-ed-media"
            data-id={shown.asset.id}
          />
        )}
        {hold && before ? (
          <div className="cmp-label" data-testid="studio-ed-parent-label">
            Parent version
          </div>
        ) : null}
        {split && before && !hold && !pending && crop === null ? <Split before={before} /> : null}
        {pending ? (
          <>
            <div className="ed-dots" />
            <div className="ed-pill" data-testid="studio-ed-overlay">
              {pending.state === 'running'
                ? `Generating ${Math.round(pending.progress * 100)}%`
                : 'Waiting in the GPU queue'}
            </div>
            <button
              type="button"
              className="ed-cancel"
              data-testid="studio-ed-cancel"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onCancel(pending.id)}
            >
              Cancel
            </button>
          </>
        ) : null}
        {box && !pending && !hold && crop === null ? (
          <div
            className="ed-mask"
            data-testid="studio-ed-mask"
            style={{
              left: `${box[0] * 100}%`,
              top: `${box[1] * 100}%`,
              width: `${box[2] * 100}%`,
              height: `${box[3] * 100}%`,
            }}
          />
        ) : null}
        {crop !== null && !pending ? <CropBox rect={crop} onChange={onCrop} /> : null}
      </div>
    </div>
  )
}

/** Draggable before/after divider: the parent on the left, the current version on the right. */
function Split({ before }: { before: StudioItem }) {
  const [pos, setPos] = useState(50)
  const move = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    const r = e.currentTarget.parentElement!.getBoundingClientRect()
    setPos(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)))
  }
  return (
    <>
      <img
        src={mediaSrc(before.asset.path)}
        alt=""
        className="cmp-before"
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
        draggable={false}
        data-testid="studio-ed-split-before"
      />
      <span className="cmp-label">Before</span>
      <span className="cmp-label r">After</span>
      <div
        className="cmp-handle"
        style={{ left: `${pos}%` }}
        onPointerDown={(e) => {
          e.stopPropagation()
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={move}
        role="slider"
        aria-label="Compare position"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pos)}
        data-testid="studio-ed-split"
      >
        <span />
      </div>
    </>
  )
}

const CORNERS = ['nw', 'ne', 'sw', 'se'] as const

/** The crop rectangle: drag it to move, drag a corner to resize. */
function CropBox({ rect, onChange }: { rect: CropRect; onChange: (rect: CropRect) => void }) {
  const layer = useRef<HTMLDivElement>(null)
  const drag = useRef<{ grip: CropGrip; x: number; y: number; start: CropRect } | null>(null)
  const grab = (grip: CropGrip) => (e: ReactPointerEvent<HTMLElement>) => {
    e.stopPropagation()
    if (e.button !== 0 || !layer.current) return
    layer.current.setPointerCapture(e.pointerId)
    drag.current = { grip, x: e.clientX, y: e.clientY, start: rect }
  }
  const move = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    const r = e.currentTarget.getBoundingClientRect()
    onChange(dragCrop(d.grip, d.start, (e.clientX - d.x) / r.width, (e.clientY - d.y) / r.height))
  }
  return (
    <div
      ref={layer}
      className="ed-croplayer"
      onPointerMove={move}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    >
      <div
        className="ed-crop"
        data-testid="studio-ed-crop"
        onPointerDown={grab('move')}
        style={{
          left: `${rect.x * 100}%`,
          top: `${rect.y * 100}%`,
          width: `${rect.w * 100}%`,
          height: `${rect.h * 100}%`,
        }}
      >
        {CORNERS.map((c) => (
          <i key={c} data-corner={c} onPointerDown={grab(c)} />
        ))}
      </div>
    </div>
  )
}
