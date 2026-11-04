import { useRef } from 'react'
import { isAppSwitchUrl } from '@evaos/browser-core/app-switch'
import './browser.css'
import { AddressRow } from './AddressRow'
import { AppSwitcher } from './AppSwitcher'
import { PageStateCard } from './PageStateCard'
import { PasskeyBar } from './PasskeyBar'
import { TabStrip } from './TabStrip'
import { activeTab, useBrowserStore } from './browser-store'
import { useSlotSync } from './useSlotSync'

/**
 * The Browser tool tab. `hidden` keeps it mounted but out of layout, so its slot (and native view)
 * sizes to 0. The browser store and scope run from app start (App), not from this tab.
 */
export function BrowserPanel({ hidden = false }: { hidden?: boolean }) {
  const slot = useRef<HTMLDivElement>(null)
  const tabs = useBrowserStore((s) => s.tabs)
  const activeId = useBrowserStore((s) => s.activeId)
  const tab = useBrowserStore(activeTab)
  useSlotSync(slot)

  // A scope with no tabs shows the new-tab state; the address bar opens its first tab.
  const showCard = tab === undefined || tab.blank || tab.error !== null
  return (
    <section
      className="eva-browser"
      data-testid="browser-panel"
      style={hidden ? { display: 'none' } : undefined}
    >
      <AddressRow tab={tab} />
      {/* The tab row has room the address row lacks in a narrow panel; the app chip ends it. */}
      <div className="eva-browser-tabs">
        <TabStrip tabs={tabs} activeId={activeId} />
        {tab && isAppSwitchUrl(tab.url) ? <AppSwitcher key={tab.id} tab={tab} /> : null}
      </div>
      {tab?.passkey && !showCard ? <PasskeyBar tab={tab} /> : null}
      <div className="eva-browser-slot" data-testid="browser-slot" ref={slot}>
        {showCard ? <PageStateCard tab={tab} /> : null}
      </div>
    </section>
  )
}
