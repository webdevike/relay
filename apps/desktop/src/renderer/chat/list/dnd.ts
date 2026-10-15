/** What a draggable carries: a chat row (with the group it sits in) or a group header. */
export type DragData =
  { type: 'chat'; id: string; group?: string } | { type: 'group'; name: string }

export type Drop =
  | { kind: 'assign'; id: string; group: string }
  | { kind: 'reorder'; moving: string; target: string }

/** Pointer activation distance: a click without movement still opens the chat or the menu. */
export const ACTIVATION_DISTANCE = 4

/**
 * What a finished drag means. A chat dropped on a header or on another chat is assigned to that
 * group; a header dropped on another header (or a chat inside one) reorders the headers.
 */
export function resolveDrop(
  active: DragData,
  over: DragData | null,
  shownGroups: readonly string[],
): Drop | null {
  if (over === null) return null
  const targetGroup =
    over.type === 'group' ? over.name : over.group !== undefined ? over.group : null
  if (targetGroup === null) return null
  if (active.type === 'chat') {
    if (active.group === targetGroup) return null
    return { kind: 'assign', id: active.id, group: targetGroup }
  }
  if (active.name === targetGroup) return null
  if (!shownGroups.includes(active.name) || !shownGroups.includes(targetGroup)) return null
  return { kind: 'reorder', moving: active.name, target: targetGroup }
}
