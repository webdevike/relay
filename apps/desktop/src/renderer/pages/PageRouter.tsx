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
  const key = placeKey(place)
  const Page = pageRegistry[meta.kind as PageRegistryKind] ?? pageRegistry.page
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
          <ScrollArea
            data-testid="page-scroll"
            scrollKey={key}
            fadeBg="var(--eva-c-background)"
            className="eva-page-scroll"
          >
            <Page key={key} place={place} />
          </ScrollArea>
        </div>
      )}
    </>
  )
}
