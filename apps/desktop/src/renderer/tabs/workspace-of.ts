import { workspaceOf, type OwnerOf, type Place, type Tab } from '@evaos/shell-core'

/**
 * Which workspace an app tab belongs to (shell-core workspace.ts): its assistant when the chat's
 * owner chain ends at one, else its chat or page. The owner chain comes from the chat list and
 * the activity feed (chat/workspace-owners.ts sets it once they load).
 */
let ownerOf: OwnerOf = () => null

export function setOwnerResolver(fn: OwnerOf): void {
  ownerOf = fn
}

export function workspaceOfTab(tab: Pick<Tab, 'id' | 'here'>): string {
  return workspaceOf(tab.here, tab.id, ownerOf)
}

/** The workspace `place` opens in (a new chat draft gets a workspace of its own). */
export function workspaceOfPlace(place: Place): string {
  return workspaceOf(place, -1, ownerOf)
}

/**
 * Whether the workspace on screen is nothing but its one tab (no panes of its own, no unsent
 * text), so going elsewhere may take that tab along (shell-core routeTo `reuse`). The tiling
 * store answers it (tiling-store.ts sets it).
 */
let frontBare: () => boolean = () => false

export function setFrontBareCheck(fn: () => boolean): void {
  frontBare = fn
}

export const isFrontBare = (): boolean => frontBare()
