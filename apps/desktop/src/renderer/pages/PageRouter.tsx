import { placeKey, type Place } from '@evaos/shell-core'
import { ChatPane } from '../chat/ChatPane'
import { ScrollArea } from '../ui/ScrollArea'
import { activePlace, useTabs } from '../tabs/tabs-store'
import { agentFile, useAssistants } from '../assistants/assistants-store'
import { pageMeta } from './page-meta'
import { pageRegistry, type PageRegistryKind } from './registry'
import './pages.css'

/** One page other than a chat, in its page area: in the chat pane, or as a page tab in a tool pane. */
export function PageView({ place }: { place: Place }) {
  const meta = pageMeta(place)
  // The theme editor, Canvas, Rooms, Studio and Reviews own their scrolling (two panes; a board; a
  // chat feed; a composer beside a gallery; a queue beside a pull request), and so does an
  // assistant's page (a thread's log scrolls itself; its start card scrolls on its own).
  const ownsScroll =
    (meta.kind === 'settings' && place.settingsSection === 'Theme') ||
    meta.kind === 'canvas' ||
    meta.kind === 'agent' ||
    meta.slug === 'rooms' ||
    meta.slug === 'studio' ||
    meta.slug === 'reviews'
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

/**
 * Place-driven page area. The single ChatPane stays mounted, hidden off the chat place (D-06,
 * D-07); an agent whose thread has a session file shows it there too, like native Page::Agent.
 */
export function PageRouter() {
  const place = useTabs(activePlace)
  const thread = useAssistants((s) => agentFile(s, place))
  const isChat = pageMeta(place).kind === 'chat' || thread !== null
  return (
    <>
      <div
        className="eva-page-chat"
        data-testid="page-chat-wrap"
        style={{ display: isChat ? 'flex' : 'none' }}
      >
        <ChatPane />
      </div>
      {isChat ? null : <PageView place={place} />}
    </>
  )
}
