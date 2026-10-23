import type { Place } from './place'

/** The scope pinned browser tabs live in: no session owns them and every scope shows them. */
export const PINNED_SCOPE = '*'

/**
 * The browser scope of what the active app tab shows. A chat with a session file is
 * `chat:<file>`; an unsent draft is `draft:<app tab id>` (renamed to its chat scope once omp
 * names the file); every other page is `page:<page key>` plus the place's own id where it has
 * one (canvas slug, meeting stem; a workspace's id is already in its page key).
 */
export function browserScope(place: Place, appTabId: number): string {
  switch (place.page) {
    case 'chat':
      return place.chat === null || place.chat === 'draft'
        ? `draft:${appTabId}`
        : `chat:${place.chat}`
    case 'canvas':
      return place.canvas === null ? 'page:canvas' : `page:canvas:${place.canvas}`
    case 'meetings':
      return place.meeting === null ? 'page:meetings' : `page:meetings:${place.meeting}`
    default:
      return `page:${place.page}`
  }
}
