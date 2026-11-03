// Join a live canvas from a chat. By default it opens in a pane beside the chat, which stays on
// screen. Option+click joins in the same tab and Cmd+click in a new one; those remember where Isaac
// was to come back to exactly there: the same tab's history (Back pops the canvas), the
// transcript's scroll offset and the unsent draft (the composer stays mounted, and drafts.ts keeps
// it by session file). The panes stay as they are: the tiling is the window's, not the page's.
import { activeTab, placeEquals, placeOf, type Place } from '@evaos/shell-core'
import { openInApp } from '../../navigation/open-in-app'
import type { OpenTarget } from '../../navigation/open-target'
import { goBack, navigateTo, tabsStore } from '../../tabs/tabs-store'
import { chatStore } from '../../chat/chat-store'
import { PANE_ID } from '../../chat/open-chat'
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
 * Opens the board's live room per `target` (default: a split right of the chat). In the same tab
 * (or a new one) it remembers the chat in front for the way back; in a split the chat stays on
 * screen, so there is nothing to return to.
 */
export function joinCanvas(slug: string, target: OpenTarget = 'split'): void {
  if (target === 'split') {
    points.delete(slug)
  } else {
    const place = activeTab(tabsStore.getState().tabs).here
    const file = chatStore.getState().panes[PANE_ID]?.file ?? ''
    points.set(slug, {
      place,
      file,
      scroll: file === '' ? null : chatScrollOf(file),
    })
  }
  openInApp(placeOf('canvas', { canvas: slug }), target)
}

/** Opens a board (its live room while one is, else the board itself) per `target`. */
export function openBoard(slug: string, target: OpenTarget = 'split'): void {
  openInApp(placeOf('canvas', { canvas: slug }), target)
}

/**
 * Back to the chat the room on `slug` was joined from: Back when it is the tab's previous page,
 * else a visit to it. The transcript goes back to its offset. With
 * no return point (the board was opened another way), `origin` is the room's own chat.
 */
export function backToChat(slug: string, origin: Place | null): void {
  const point = points.get(slug) ?? null
  const target = point?.place ?? origin
  if (target === null) return
  points.delete(slug)
  if (point?.scroll && point.file !== '') requestChatScroll(point.file, point.scroll)
  const prev = activeTab(tabsStore.getState().tabs).back.at(-1)
  if (prev && placeEquals(prev, target)) goBack()
  else navigateTo(target)
}

export function resetReturnPointsForTests(): void {
  points.clear()
}
