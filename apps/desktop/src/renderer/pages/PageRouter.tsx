import { placeKey } from '@evaos/shell-core'
import { ChatPane } from '../chat/ChatPane'
import { ScrollArea } from '../ui/ScrollArea'
import { activePlace, useTabs } from '../tabs/tabs-store'
import { pageMeta } from './page-meta'
import { pageRegistry, type PageRegistryKind } from './registry'
import './pages.css'

/** Place-driven page area. The single ChatPane stays mounted, hidden off the chat place (D-06, D-07). */
export function PageRouter() {
  const place = useTabs(activePlace)
  const meta = pageMeta(place)
  const isChat = meta.kind === 'chat'
  // The theme editor and Canvas own their scrolling (two panes; a pannable board).
  const ownsScroll =
    (meta.kind === 'settings' && place.settingsSection === 'Theme') || meta.kind === 'canvas'
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
