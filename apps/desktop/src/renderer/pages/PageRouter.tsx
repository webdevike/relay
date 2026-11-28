import { placeKey, type Place } from '@evaos/shell-core'
import { ScrollArea } from '../ui/ScrollArea'
import { pageMeta } from './page-meta'
import { pageRegistry, type PageRegistryKind } from './registry'
import './pages.css'

/**
 * Pages that own their scrolling: a canvas board, an assistant's thread, a review item, a room's
 * chat feed, a ticket (its main column beside a sticky sidebar).
 */
const OWN_SCROLL_KINDS: Partial<Record<string, true>> = {
  canvas: true,
  agent: true,
  review: true,
  room: true,
  ticket: true,
}
/** Studio, Skills, Reviews (a list beside an editor or a detail), and the Board's columns. */
const OWN_SCROLL_PAGES: Partial<Record<string, true>> = {
  studio: true,
  skills: true,
  reviews: true,
  board: true,
}

/**
 * One page other than a chat, in its app tab's card (tiling/dock AppPanel shows chats and
 * assistant threads itself).
 */
export function PageView({ place }: { place: Place }) {
  const meta = pageMeta(place)
  // The theme editor's two panes scroll each on their own, and so do the pages above.
  const ownsScroll =
    (meta.kind === 'settings' && place.settingsSection === 'Theme') ||
    OWN_SCROLL_KINDS[meta.kind] === true ||
    (meta.kind === 'page' && OWN_SCROLL_PAGES[meta.slug] === true)
  const key = placeKey(place)
  const Page = pageRegistry[meta.kind as PageRegistryKind]
  return (
    <div className="eva-page-area">
      {ownsScroll ? (
        <Page key={key} place={place} />
      ) : (
        <ScrollArea data-testid="page-scroll" scrollKey={key} className="eva-page-scroll">
          <Page key={key} place={place} />
        </ScrollArea>
      )}
    </div>
  )
}
