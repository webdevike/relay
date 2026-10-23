import { useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { Badge, Stack } from '@mantine/core'
import { IconArrowsHorizontal } from '@tabler/icons-react'
import type { CompareSpec } from '@evaos/chat-core/widget'
import { mediaUrl } from '../media-url'
import { MediaImage, WidgetTitle } from './parts'

/** Arrow keys move the divider this many percent; with Shift, STEP_BIG. */
const STEP = 5
const STEP_BIG = 20
/** Until the after image loads (widgets.rs GALLERY_ASPECT). */
const DEFAULT_ASPECT = 4 / 3

/**
 * Before/after slider: the after image fills the frame, the before image is clipped over it up to
 * the divider. Drag (or click) anywhere in the frame, or focus the divider and use the arrows.
 * The frame takes the after image's aspect ratio.
 */
export function CompareWidget({ spec }: { spec: CompareSpec }) {
  const [pos, setPos] = useState(50)
  const [aspect, setAspect] = useState(DEFAULT_ASPECT)
  const frame = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const moveTo = (clientX: number): void => {
    const rect = frame.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return
    setPos(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)))
  }
  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    dragging.current = true
    e.currentTarget.setPointerCapture?.(e.pointerId)
    moveTo(e.clientX)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (dragging.current) moveTo(e.clientX)
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    dragging.current = false
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  const beforeLabel = spec.before.label ?? 'Before'
  const afterLabel = spec.after.label ?? 'After'
  return (
    <Stack gap="sm" data-testid="widget-compare">
      {spec.title !== undefined ? <WidgetTitle>{spec.title}</WidgetTitle> : null}
      <div
        ref={frame}
        className="eva-w-frame eva-w-compare"
        data-testid="compare-frame"
        style={{ aspectRatio: aspect, '--eva-w-pos': `${pos}%` } as CSSProperties}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <MediaImage src={mediaUrl(spec.after.src)} alt={afterLabel} onAspect={setAspect} />
        <MediaImage
          src={mediaUrl(spec.before.src)}
          alt={beforeLabel}
          className="eva-w-compare-before"
        />
        <div
          className="eva-w-compare-divider"
          role="slider"
          tabIndex={0}
          aria-label="Before and after divider"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pos)}
          aria-valuetext={`${Math.round(pos)}% before`}
          onKeyDown={(e) => {
            const step = e.shiftKey ? STEP_BIG : STEP
            const next =
              e.key === 'ArrowLeft'
                ? pos - step
                : e.key === 'ArrowRight'
                  ? pos + step
                  : e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? 100
                      : null
            if (next === null) return
            e.preventDefault()
            setPos(Math.min(100, Math.max(0, next)))
          }}
        >
          <span className="eva-w-compare-handle">
            <IconArrowsHorizontal size={14} stroke={2} />
          </span>
        </div>
        <Badge
          className="eva-w-tag"
          style={{ left: 'var(--mantine-spacing-xs)' }}
          size="sm"
          variant="default"
          tt="none"
        >
          {beforeLabel}
        </Badge>
        <Badge
          className="eva-w-tag"
          style={{ right: 'var(--mantine-spacing-xs)' }}
          size="sm"
          variant="default"
          tt="none"
        >
          {afterLabel}
        </Badge>
      </div>
    </Stack>
  )
}
