// Join a live canvas from a chat. By default it opens as a page tab beside the chat, in the chat's
// workspace. Joining it on its own opens the Canvas workspace; that remembers where Isaac was to
// come back to exactly there: the chat's workspace with its panes as they were, the transcript's
// scroll offset and the unsent draft (drafts.ts keeps it by session file).
import { activeTab, placeEquals, placeOf, type Place } from '@evaos/shell-core'
import { openInApp } from '../../navigation/open-in-app'
import type { OpenTarget } from '../../navigation/open-target'
import { historyBack, previousSpot } from '../../navigation/nav-history'
import { navigateTo, tabsStore } from '../../tabs/tabs-store'
import { chatStore } from '../../chat/chat-store'
import { frontChatPaneOf } from '../../chat/front-chat'
import { chatScrollOf, requestChatScroll, type ChatScroll } from '../../chat/chat-scroll'

/** Where Isaac was when he joined a board's room. */
export interface ReturnPoint {
  /** The place the tab showed: a chat, or an assistant's thread page. */
  place: Place
  /** The session file the chat pane showed ('' for a new chat). */
  file: string
  scroll: ChatScroll | null
}

/** By board slug: the latest join of each board wins. */
const points = new Map<string, ReturnPoint>()

export function returnPointOf(slug: string): ReturnPoint | null {
  return points.get(slug) ?? null
}

/**
 * Opens the board's live room per `target` (default `here`: a page tab beside the chat, in the
 * chat's workspace; also `background` and `split`). On its own (`tab`) it opens the Canvas
 * workspace and remembers the chat in front for the way back; beside the chat it stays on
 * screen, so there is nothing to return to.
 */
export function joinCanvas(slug: string, target: OpenTarget = 'here'): void {
  if (target !== 'tab') {
    points.delete(slug)
  } else {
    const place = activeTab(tabsStore.getState().tabs).here
    const file = chatStore.getState().panes[frontChatPaneOf()]?.file ?? ''
    points.set(slug, {
      place,
      file,
      scroll: file === '' ? null : chatScrollOf(file),
    })
  }
  openInApp(placeOf('canvas', { canvas: slug }), target)
}

/** Opens a board (its live room while one is, else the board itself) per `target`. */
export function openBoard(slug: string, target: OpenTarget = 'here'): void {
  openInApp(placeOf('canvas', { canvas: slug }), target)
}

/**
 * Back to the chat the room on `slug` was joined from: the window's Back when that is the spot
 * before this one, else a visit to it. The transcript goes back to its offset. With
 * no return point (the board was opened another way), `origin` is the room's own chat.
 */
export function backToChat(slug: string, origin: Place | null): void {
  const point = points.get(slug) ?? null
  const target = point?.place ?? origin
  if (target === null) return
  points.delete(slug)
  if (point?.scroll && point.file !== '') requestChatScroll(point.file, point.scroll)
  const prev = previousSpot()
  if (prev && placeEquals(prev.place, target)) historyBack()
  else navigateTo(target)
}

export function resetReturnPointsForTests(): void {
  points.clear()
}
