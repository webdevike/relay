import { useEffect, useRef, useState } from 'react'
import { GAP, findNode, minSize, type DividerRect } from '@evaos/shell-core'
import { useOccludeBrowser } from '../overlay/overlay-store'
import { setSizes, tilingStore } from './tiling-store'

const STEP = 16
const BIG_STEP = 48

/**
 * The gap between two siblings of a split; dragging it moves the space between them. Each side
 * keeps its smallest size; double-click (or Home) shares the two evenly.
 */
export function Divider({ d, length }: { d: DividerRect; length: number }) {
  const [dragging, setDragging] = useState(false)
  const finishDrag = useRef<(() => void) | null>(null)
  useOccludeBrowser(dragging)
  useEffect(() => () => finishDrag.current?.(), [])
  const row = d.dir === 'row'

  /** New shares for the pair after moving the divider `dx` px, held to both minimums. */
  const shifted = (sizes: readonly number[], dx: number): number[] | null => {
    const split = findNode(tilingStore.getState().tiling.root, d.split)
    if (!split || split.type !== 'split') return null
    const a = split.children[d.index]
    const b = split.children[d.index + 1]
    if (!a || !b) return null
    const free = length - GAP * (split.children.length - 1)
    if (free <= 0) return null
    const axis = row ? 'w' : 'h'
    const pair = (sizes[d.index] ?? 0) + (sizes[d.index + 1] ?? 0)
    const minA = minSize(a, axis, GAP) / free
    const minB = minSize(b, axis, GAP) / free
    const want = (sizes[d.index] ?? 0) + dx / free
    const nextA = minA + minB > pair ? pair / 2 : Math.min(Math.max(want, minA), pair - minB)
    const next = [...sizes]
    next[d.index] = nextA
    next[d.index + 1] = pair - nextA
    return next
  }

  const current = (): number[] => {
    const split = findNode(tilingStore.getState().tiling.root, d.split)
    return split?.type === 'split' ? [...split.sizes] : []
  }

  const nudge = (dx: number): void => {
    const next = shifted(current(), dx)
    if (next) setSizes(d.split, next)
  }

  const even = (): void => {
    const sizes = current()
    const pair = (sizes[d.index] ?? 0) + (sizes[d.index + 1] ?? 0)
    sizes[d.index] = pair / 2
    sizes[d.index + 1] = pair / 2
    if (sizes.length) setSizes(d.split, sizes)
  }

  return (
    <div
      className={`eva-grip eva-divider eva-divider-${d.dir}${dragging ? ' is-dragging' : ''}`}
      style={{ left: d.rect.x, top: d.rect.y, width: d.rect.w, height: d.rect.h }}
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label={row ? 'Resize panes side by side' : 'Resize stacked panes'}
      tabIndex={0}
      data-testid={`divider-${d.split}-${d.index}`}
      onPointerDown={(e) => {
        if (e.button !== 0 || finishDrag.current) return
        e.preventDefault()
        const target = e.currentTarget
        const pointerId = e.pointerId
        const start = row ? e.clientX : e.clientY
        const startSizes = current()
        let frame = 0
        let pending: number | null = null
        const flush = (): void => {
          cancelAnimationFrame(frame)
          frame = 0
          if (pending === null) return
          const next = shifted(startSizes, pending)
          pending = null
          if (next) setSizes(d.split, next)
        }
        const move = (ev: PointerEvent): void => {
          if (ev.pointerId !== pointerId) return
          if (ev.buttons === 0) {
            finish()
            return
          }
          pending = (row ? ev.clientX : ev.clientY) - start
          if (!frame) frame = requestAnimationFrame(flush)
        }
        const finish = (): void => {
          if (!finishDrag.current) return
          finishDrag.current = null
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          window.removeEventListener('pointercancel', finish)
          window.removeEventListener('blur', finish)
          flush()
          if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId)
          document.body.classList.remove('eva-resizing', 'eva-resizing-rows')
          setDragging(false)
        }
        const up = (ev: PointerEvent): void => {
          if (ev.pointerId !== pointerId) return
          pending = (row ? ev.clientX : ev.clientY) - start
          finish()
        }
        finishDrag.current = finish
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', finish)
        window.addEventListener('blur', finish)
        target.setPointerCapture?.(pointerId)
        document.body.classList.add(row ? 'eva-resizing' : 'eva-resizing-rows')
        setDragging(true)
      }}
      onDoubleClick={even}
      onKeyDown={(e) => {
        if (e.key === 'Home') {
          e.preventDefault()
          even()
          return
        }
        const back = row ? 'ArrowLeft' : 'ArrowUp'
        const forward = row ? 'ArrowRight' : 'ArrowDown'
        if (e.key !== back && e.key !== forward) return
        e.preventDefault()
        const step = e.shiftKey ? BIG_STEP : STEP
        nudge(e.key === forward ? step : -step)
      }}
    >
      <span className="eva-grip-bar" />
    </div>
  )
}
