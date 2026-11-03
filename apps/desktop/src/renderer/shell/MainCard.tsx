import { agentFile, useAssistants } from '../assistants/assistants-store'
import { PageRouter } from '../pages/PageRouter'
import { TabBar } from '../tabs/TabBar'
import { activePlace, useTabs } from '../tabs/tabs-store'
import { MainHeader } from './MainHeader'

/** Native main column: draggable tabs above, not inside, the bordered page. */
export function MainCard() {
  const loaded = useTabs((s) => s.loaded)
  const place = useTabs(activePlace)
  // The chat pane brings its own header, on a chat and on an agent's thread.
  const thread = useAssistants((s) => agentFile(s, place))
  const isChat = place.page === 'chat' || thread !== null
  return (
    <div className="eva-main-column" data-testid="main-column">
      {loaded ? <TabBar /> : null}
      <section className="eva-card eva-main-card" data-testid="main-card">
        {loaded ? (
          <>
            {isChat ? null : <MainHeader />}
            <PageRouter />
          </>
        ) : null}
      </section>
    </div>
  )
}
