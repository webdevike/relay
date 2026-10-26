import { placeKey } from '@evaos/shell-core'
import { ChatPane } from '../chat/ChatPane'
import { ScrollArea } from '../ui/ScrollArea'
import { activePlace, useTabs } from '../tabs/tabs-store'
import { agentFile, useAssistants } from '../assistants/assistants-store'
import { pageMeta } from './page-meta'
import { pageRegistry, type PageRegistryKind } from './registry'
import './pages.css'

/**
 * Place-driven page area. The single ChatPane stays mounted, hidden off the chat place (D-06,
 * D-07); an agent whose thread has a session file shows it there too, like native Page::Agent.
 */
export function PageRouter() {
  const place = useTabs(activePlace)
  const thread = useAssistants((s) => agentFile(s, place))
  const meta = pageMeta(place)
  const isChat = meta.kind === 'chat' || thread !== null
  // The theme editor, Canvas and Rooms own their scrolling (two panes; a board; a chat feed).
  const ownsScroll =
    (meta.kind === 'settings' && place.settingsSection === 'Theme') ||
    meta.kind === 'canvas' ||
    meta.slug === 'rooms'
  const key = placeKey(place)
  const Page = pageRegistry[meta.kind as PageRegistryKind]
  return (
    <>
      <div
        className="eva-page-chat"
        data-testid="page-chat-wrap"
        style={{ display: isChat ? 'flex' : 'none' }}
      >
        <ChatPane />
      </div>
      {isChat ? null : (
        <div className="eva-page-area">
          {ownsScroll ? (
            <Page key={key} place={place} />
          ) : (
            <ScrollArea data-testid="page-scroll" scrollKey={key} className="eva-page-scroll">
              <Page key={key} place={place} />
            </ScrollArea>
          )}
        </div>
      )}
    </>
  )
}
