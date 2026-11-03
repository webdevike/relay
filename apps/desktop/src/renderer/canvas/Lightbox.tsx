/**
 * A board's images full window: one at a time at its natural size, fit to the window until
 * zoomed. Wheel or pinch zooms at the pointer, dragging pans, double-click toggles fit and actual
 * size, Left/Right step through the board's images in board order, + and - zoom, 0 fits, 1 shows
 * actual size, Escape closes.
 */
import { ActionIcon, Tooltip } from '@mantine/core'
import {
  IconArrowLeft,
  IconArrowRight,
  IconArrowsMinimize,
  IconMinus,
  IconPhoto,
  IconPlus,
} from '@tabler/icons-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { EvaModal } from '../overlay'
import { useCanvasImage } from './cards/canvas-image'
import {
  MAX_SCALE,
  ZOOM_STEP,
  clampPan,
  fitScale,
  fitView,
  panBy,
  step,
  wheelFactor,
  zoomTo,
  type LightboxImage,
  type Size,
  type View,
} from './lightbox-model'

type ViewChange = (view: View, natural: Size, stage: Size) => View

function LightboxButton({
  label,
  testid,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string
  testid: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip label={label} openDelay={400} zIndex={400}>
      <ActionIcon
        variant="subtle"
        color="gray"
        size={28}
        className="eva-lb-btn"
        aria-label={label}
        data-testid={testid}
        data-active={active ? 'true' : undefined}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </ActionIcon>
    </Tooltip>
  )
}

/** Where a pointer event sits relative to the element's center. */
function fromCenter(el: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const r = el.getBoundingClientRect()
  return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 }
}

/** The stage and the picture on it, sized by `view`; scale 1 is one image pixel per CSS pixel. */
function Stage({
  slug,
  image,
  view,
  pannable,
  onNatural,
  onStage,
  onView,
}: {
  slug: string
  image: LightboxImage
  view: { view: View; natural: Size } | null
  pannable: boolean
  onNatural: (id: string, size: Size) => void
  onStage: (size: Size) => void
  onView: (change: ViewChange) => void
}) {
  const loaded = useCanvasImage(slug, image.src)
  const stageRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; y: number } | null>(null)

  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const report = (): void => onStage({ width: el.clientWidth, height: el.clientHeight })
    report()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [onStage])

  // Wheel and pinch zoom at the pointer; a native listener so the page itself never zooms.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const at = fromCenter(el, e.clientX, e.clientY)
      onView((v, n, s) => zoomTo(v, v.scale * wheelFactor(e.deltaY, e.ctrlKey), n, s, at))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onView])

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const last = dragRef.current
    if (!last) return
    dragRef.current = { x: e.clientX, y: e.clientY }
    onView((v, n, s) => panBy(v, e.clientX - last.x, e.clientY - last.y, n, s))
  }
  const onPointerUp = (): void => {
    dragRef.current = null
  }

  return (
    <div
      ref={stageRef}
      className="eva-lb-stage"
      data-testid="canvas-lightbox-stage"
      data-pannable={pannable ? 'true' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => {
        const at = fromCenter(e.currentTarget, e.clientX, e.clientY)
        onView((v, n, s) => (v.scale > fitScale(n, s) ? fitView(n, s) : zoomTo(v, 1, n, s, at)))
      }}
    >
      {loaded?.state === 'ready' ? (
        <img
          key={image.id}
          className="eva-lb-img"
          src={loaded.dataUrl}
          alt={image.title || image.caption || 'Board image'}
          draggable={false}
          data-testid="canvas-lightbox-img"
          onLoad={(e) =>
            onNatural(image.id, {
              width: e.currentTarget.naturalWidth,
              height: e.currentTarget.naturalHeight,
            })
          }
          style={
            view
              ? {
                  width: view.natural.width * view.view.scale,
                  height: view.natural.height * view.view.scale,
                  transform: `translate(calc(-50% + ${view.view.x}px), calc(-50% + ${view.view.y}px))`,
                }
              : { visibility: 'hidden' }
          }
        />
      ) : (
        <div className="eva-lb-note">
          <IconPhoto size={16} stroke={1.5} aria-hidden />
          <span>{loaded?.state === 'failed' ? loaded.message : 'Loading'}</span>
        </div>
      )}
    </div>
  )
}

export interface LightboxProps {
  slug: string
  /** The board's images in board order. */
  images: readonly LightboxImage[]
  /** The image to open on; null keeps the lightbox closed. */
  openId: string | null
  onClose: () => void
}

export function Lightbox({ slug, images, openId, onClose }: LightboxProps) {
  const [index, setIndex] = useState(0)
  const [stage, setStage] = useState<Size | null>(null)
  /** The shown image's natural size and view, keyed by image so a step never shows a stale one. */
  const [shownView, setShownView] = useState<{ id: string; natural: Size; view: View } | null>(null)
  /** Whether the view follows the window: true until the image is zoomed or panned. */
  const fittedRef = useRef(true)
  const opened = openId !== null
  const count = images.length
  const shown = Math.min(index, Math.max(0, count - 1))
  const image = images[shown]

  const imagesRef = useRef(images)
  imagesRef.current = images
  // Opening reads the board as it is; later board edits keep the current index.
  useEffect(() => {
    if (openId === null) return
    setIndex(
      Math.max(
        0,
        imagesRef.current.findIndex((i) => i.id === openId),
      ),
    )
    setShownView(null)
  }, [openId])

  const current = shownView !== null && shownView.id === image?.id ? shownView : null

  const stageRef = useRef(stage)
  stageRef.current = stage

  /** A loaded image starts fit to the stage. */
  const onNatural = useCallback((id: string, natural: Size) => {
    const s = stageRef.current
    fittedRef.current = true
    setShownView({ id, natural, view: s ? fitView(natural, s) : { scale: 1, x: 0, y: 0 } })
  }, [])

  // Follow the window: refit while fitted, else keep the image in bounds.
  useEffect(() => {
    if (!stage) return
    setShownView((sv) =>
      sv === null
        ? sv
        : {
            ...sv,
            view: fittedRef.current
              ? fitView(sv.natural, stage)
              : clampPan(sv.view, sv.natural, stage),
          },
    )
  }, [stage])

  const change = useCallback((fn: ViewChange) => {
    const s = stageRef.current
    if (!s) return
    setShownView((sv) => {
      if (!sv) return sv
      const view = fn(sv.view, sv.natural, s)
      fittedRef.current = view.scale === fitScale(sv.natural, s) && view.x === 0 && view.y === 0
      return { ...sv, view }
    })
  }, [])

  const go = useCallback((delta: number) => setIndex((i) => step(i, delta, count)), [count])
  const zoomBy = useCallback(
    (factor: number) => change((v, n, s) => zoomTo(v, v.scale * factor, n, s)),
    [change],
  )
  const fit = useCallback(() => change((_v, n, s) => fitView(n, s)), [change])
  const actual = useCallback(() => change((v, n, s) => zoomTo(v, 1, n, s)), [change])

  useEffect(() => {
    if (!opened) return
    const keys: Record<string, () => void> = {
      ArrowLeft: () => go(-1),
      ArrowRight: () => go(1),
      '+': () => zoomBy(ZOOM_STEP),
      '=': () => zoomBy(ZOOM_STEP),
      '-': () => zoomBy(1 / ZOOM_STEP),
      _: () => zoomBy(1 / ZOOM_STEP),
      '0': fit,
      '1': actual,
    }
    const onKey = (e: KeyboardEvent): void => {
      const fn = keys[e.key]
      if (!fn || e.metaKey || e.ctrlKey || e.altKey) return
      e.preventDefault()
      fn()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [opened, go, zoomBy, fit, actual])

  const fitAt = current && stage ? fitScale(current.natural, stage) : 1
  const scale = current?.view.scale ?? fitAt
  const ready = current !== null && stage !== null
  const pannable =
    ready &&
    (current.natural.width * scale > stage.width + 0.5 ||
      current.natural.height * scale > stage.height + 0.5)
  const heading = image?.title || image?.caption || 'Image'

  return (
    <EvaModal
      opened={opened && image !== undefined}
      onClose={onClose}
      fullScreen
      testid="canvas-lightbox"
      title={
        <span className="eva-lb-heading">
          <span className="eva-lb-title-row">
            <span className="eva-lb-title" data-testid="canvas-lightbox-title">
              {heading}
            </span>
            {count > 1 ? (
              <span className="eva-lb-count" data-testid="canvas-lightbox-count">
                {`${shown + 1} of ${count}`}
              </span>
            ) : null}
          </span>
          {image?.title && image.caption ? (
            <span className="eva-lb-caption" data-testid="canvas-lightbox-caption">
              {image.caption}
            </span>
          ) : null}
        </span>
      }
      actions={
        <div className="eva-lb-tools">
          <LightboxButton
            label="Zoom out (-)"
            testid="canvas-lightbox-zoom-out"
            disabled={!ready || scale <= fitAt}
            onClick={() => zoomBy(1 / ZOOM_STEP)}
          >
            <IconMinus size={16} stroke={1.5} />
          </LightboxButton>
          <span className="eva-lb-zoom" data-testid="canvas-lightbox-zoom">
            {ready ? `${Math.round(scale * 100)}%` : ''}
          </span>
          <LightboxButton
            label="Zoom in (+)"
            testid="canvas-lightbox-zoom-in"
            disabled={!ready || scale >= MAX_SCALE}
            onClick={() => zoomBy(ZOOM_STEP)}
          >
            <IconPlus size={16} stroke={1.5} />
          </LightboxButton>
          <LightboxButton
            label="Fit to window (0)"
            testid="canvas-lightbox-fit"
            disabled={!ready}
            active={ready && fittedRef.current}
            onClick={fit}
          >
            <IconArrowsMinimize size={16} stroke={1.5} />
          </LightboxButton>
          <LightboxButton
            label="Actual size (1)"
            testid="canvas-lightbox-actual"
            disabled={!ready}
            active={ready && scale === 1}
            onClick={actual}
          >
            <span className="eva-lb-actual">1:1</span>
          </LightboxButton>
          {count > 1 ? (
            <>
              <span className="eva-lb-rule" aria-hidden />
              <LightboxButton
                label="Previous image (Left arrow)"
                testid="canvas-lightbox-prev"
                disabled={shown === 0}
                onClick={() => go(-1)}
              >
                <IconArrowLeft size={16} stroke={1.5} />
              </LightboxButton>
              <LightboxButton
                label="Next image (Right arrow)"
                testid="canvas-lightbox-next"
                disabled={shown === count - 1}
                onClick={() => go(1)}
              >
                <IconArrowRight size={16} stroke={1.5} />
              </LightboxButton>
            </>
          ) : null}
        </div>
      }
    >
      {image ? (
        <Stage
          slug={slug}
          image={image}
          view={current}
          pannable={pannable}
          onNatural={onNatural}
          onStage={setStage}
          onView={change}
        />
      ) : null}
    </EvaModal>
  )
}
