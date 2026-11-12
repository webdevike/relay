import { useEffect, useRef, useState } from 'react'
import { Button, Group } from '@mantine/core'
import { EvaModal } from '../../overlay/EvaModal'

/** Pen color: Mantine's red-6, readable on light and dark pages. */
const INK = '#fa5252'

/**
 * Draws on an element's screenshot crop (`png`, base64) with a pen: Done hands back the marked
 * image as PNG base64, which replaces the plain crop in the design request. The modal occludes
 * the native page, so it shows over it.
 */
export function DesignAnnotate(props: {
  png: string
  onDone: (png: string) => void
  onCancel: () => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const image = useRef<HTMLImageElement | null>(null)
  const last = useRef<{ x: number; y: number } | null>(null)
  const [strokes, setStrokes] = useState(0)

  const paint = (): void => {
    const c = canvas.current
    const img = image.current
    if (!c || !img) return
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    c.getContext('2d')?.drawImage(img, 0, 0)
    setStrokes(0)
  }
  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      image.current = img
      paint()
    }
    img.src = `data:image/png;base64,${props.png}`
  }, [props.png])

  /** Pointer position in the canvas's own pixels (it is drawn scaled down to fit). */
  const at = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const c = e.currentTarget
    const r = c.getBoundingClientRect()
    return {
      x: ((e.clientX - r.left) * c.width) / Math.max(1, r.width),
      y: ((e.clientY - r.top) * c.height) / Math.max(1, r.height),
    }
  }
  const line = (c: HTMLCanvasElement, a: { x: number; y: number }, b: { x: number; y: number }) => {
    const ctx = c.getContext('2d')
    if (!ctx) return
    const r = c.getBoundingClientRect()
    ctx.strokeStyle = INK
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    // About 3 screen px wide whatever the crop's scale.
    ctx.lineWidth = (3 * c.width) / Math.max(1, r.width)
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }

  return (
    <EvaModal
      opened
      onClose={props.onCancel}
      title="Draw on the screenshot"
      size="auto"
      testid="design-annotate"
    >
      <div className="eva-design-annotate">
        <canvas
          ref={canvas}
          className="eva-design-canvas"
          data-testid="design-canvas"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            const p = at(e)
            last.current = p
            line(e.currentTarget, p, p)
          }}
          onPointerMove={(e) => {
            if (!last.current) return
            const p = at(e)
            line(e.currentTarget, last.current, p)
            last.current = p
          }}
          onPointerUp={() => {
            if (last.current) setStrokes((n) => n + 1)
            last.current = null
          }}
        />
        <Group justify="space-between" mt="sm">
          <Button variant="subtle" size="xs" disabled={strokes === 0} onClick={paint}>
            Clear
          </Button>
          <Group gap="xs">
            <Button variant="default" size="xs" onClick={props.onCancel}>
              Cancel
            </Button>
            <Button
              size="xs"
              data-testid="design-annotate-done"
              disabled={strokes === 0}
              onClick={() => {
                const url = canvas.current?.toDataURL('image/png') ?? ''
                props.onDone(url.slice(url.indexOf(',') + 1))
              }}
            >
              Use drawing
            </Button>
          </Group>
        </Group>
      </div>
    </EvaModal>
  )
}
