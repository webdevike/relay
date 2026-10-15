import { PageRouter } from '../pages/PageRouter'
import { TabBar } from '../tabs/TabBar'
import { activePlace, useTabs } from '../tabs/tabs-store'
import { MainHeader } from './MainHeader'

/** Native main column: draggable tabs above, not inside, the bordered page. */
export function MainCard() {
  const loaded = useTabs((s) => s.loaded)
  const isChat = useTabs((s) => activePlace(s).page === 'chat')
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
