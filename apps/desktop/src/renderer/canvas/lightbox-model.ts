/**
 * The image lightbox's arithmetic: which images a board steps through, and the zoom and pan of
 * the one shown. Scale 1 is the image's natural size in CSS pixels; `x`/`y` move the image's
 * center away from the stage's center.
 */
import type { CanvasNode } from '@evaos/contract'

export interface LightboxImage {
  id: string
  src: string
  title: string
  caption: string
}

export interface Size {
  width: number
  height: number
}

export interface View {
  scale: number
  x: number
  y: number
}

/** Furthest the lightbox zooms in, as a multiple of the natural size. */
export const MAX_SCALE = 8
/** One `+`/`-` press or button click. */
export const ZOOM_STEP = 1.25

/** Image nodes with a source, in board (file) order. */
export function boardImages(specs: readonly CanvasNode[]): LightboxImage[] {
  const out: LightboxImage[] = []
  for (const s of specs) {
    const src = s.data?.src
    if (s.type !== 'image' || !src) continue
    out.push({ id: s.id, src, title: s.data?.title ?? '', caption: s.data?.caption ?? '' })
  }
  return out
}

/** The index `delta` steps from `index`, held inside the list (no wrap). */
export function step(index: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return Math.min(count - 1, Math.max(0, index + delta))
}

/** The scale that fits the whole image in the stage, never past natural size. */
export function fitScale(image: Size, stage: Size): number {
  if (image.width <= 0 || image.height <= 0 || stage.width <= 0 || stage.height <= 0) return 1
  return Math.min(1, stage.width / image.width, stage.height / image.height)
}

/** The image fit and centered. */
export function fitView(image: Size, stage: Size): View {
  return { scale: fitScale(image, stage), x: 0, y: 0 }
}

/** Keeps the image covering the stage where it is larger, and centered where it is smaller. */
export function clampPan(view: View, image: Size, stage: Size): View {
  const held = (offset: number, img: number, box: number): number => {
    const room = (img * view.scale - box) / 2
    return room <= 0 ? 0 : Math.min(room, Math.max(-room, offset))
  }
  return {
    scale: view.scale,
    x: held(view.x, image.width, stage.width),
    y: held(view.y, image.height, stage.height),
  }
}

/**
 * Zooms to `scale` (held between fit and MAX_SCALE) keeping the stage point `at` (relative to
 * the stage's center) over the same spot of the image, then clamps the pan.
 */
export function zoomTo(
  view: View,
  scale: number,
  image: Size,
  stage: Size,
  at: { x: number; y: number } = { x: 0, y: 0 },
): View {
  const next = Math.min(MAX_SCALE, Math.max(fitScale(image, stage), scale))
  const k = next / view.scale
  return clampPan(
    { scale: next, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k },
    image,
    stage,
  )
}

/** Moves the image by a drag of `dx`/`dy` stage pixels. */
export function panBy(view: View, dx: number, dy: number, image: Size, stage: Size): View {
  return clampPan({ scale: view.scale, x: view.x + dx, y: view.y + dy }, image, stage)
}

/** How much one wheel event zooms: a trackpad pinch (ctrl) moves faster than a wheel. */
export function wheelFactor(deltaY: number, pinch: boolean): number {
  return Math.exp(-deltaY * (pinch ? 0.01 : 0.002))
}
