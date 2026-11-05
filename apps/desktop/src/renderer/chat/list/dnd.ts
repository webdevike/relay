import type { ClientRect, KeyboardCoordinateGetter } from '@dnd-kit/core'

/** What a draggable chat carries (with the folder it sits in); folder headers are drop targets. */
export type DragData =
  | { type: 'chat'; id: string; group?: string }
  | { type: 'group'; name: string }

export type Drop = { kind: 'assign'; id: string; group: string }

/** Pointer activation distance: a click without movement still opens the chat or the menu. */
export const ACTIVATION_DISTANCE = 4

/** What a finished drag means: a chat dropped on another folder's header moves into that folder. */
export function resolveDrop(active: DragData, over: DragData | null): Drop | null {
  if (active.type !== 'chat' || over?.type !== 'group') return null
  if (active.group === over.name) return null
  return { kind: 'assign', id: active.id, group: over.name }
}

const middle = (r: ClientRect): number => r.top + r.height / 2

/**
 * Keyboard drag: ArrowUp and ArrowDown move the lifted chat onto the next folder header above or
 * below its middle. Folder headers are the only drop targets, so sortable's getter (which needs
 * the dragged item to be a drop target too) does not apply.
 */
export const folderKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { currentCoordinates, context },
) => {
  const up = event.code === 'ArrowUp'
  if (!up && event.code !== 'ArrowDown') return undefined
  event.preventDefault()
  const from = context.collisionRect
  if (!from) return undefined
  const at = middle(from)
  let target: number | null = null
  for (const entry of context.droppableContainers.getEnabled()) {
    const rect = context.droppableRects.get(entry.id)
    if (!rect) continue
    const m = middle(rect)
    if (up ? m >= at - 1 : m <= at + 1) continue
    if (target === null || (up ? m > target : m < target)) target = m
  }
  return target === null
    ? undefined
    : { x: currentCoordinates.x, y: currentCoordinates.y + target - at }
}
