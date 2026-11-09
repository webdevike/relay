import { placeKey, type Place } from '@evaos/shell-core'
import { ScrollArea } from '../ui/ScrollArea'
import { pageMeta } from './page-meta'
import { pageRegistry, type PageRegistryKind } from './registry'
import './pages.css'

/**
 * One page other than a chat, in its app tab's card (tiling/dock AppPanel shows chats and
 * assistant threads itself).
 */
export function PageView({ place }: { place: Place }) {
  const meta = pageMeta(place)
  // The theme editor, Canvas, Rooms, Studio, Reviews, Skills and Agents own their scrolling (two
  // panes; a board; a chat feed; a composer beside a gallery; a queue beside a pull request; a
  // list beside an editor; columns that scroll each on their own), and so does an assistant's page
  // (a thread's log scrolls itself; its start card scrolls on its own).
  const ownsScroll =
    (meta.kind === 'settings' && place.settingsSection === 'Theme') ||
    meta.kind === 'canvas' ||
    meta.kind === 'agent' ||
    meta.kind === 'review' ||
    meta.slug === 'rooms' ||
    meta.slug === 'studio' ||
    meta.slug === 'skills' ||
    meta.slug === 'reviews' ||
    meta.slug === 'agents'
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
