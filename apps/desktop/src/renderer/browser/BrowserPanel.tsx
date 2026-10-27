import { useEffect, useRef } from 'react'
import { isAppSwitchUrl } from '@evaos/browser-core/app-switch'
import './browser.css'
import { AddressRow } from './AddressRow'
import { AppSwitcher } from './AppSwitcher'
import { PageStateCard } from './PageStateCard'
import { TabStrip } from './TabStrip'
import { startBrowserScope } from './browser-scope'
import { activeTab, startBrowserStore, useBrowserStore } from './browser-store'
import { useBrowserHotkeys } from './useBrowserHotkeys'
import { useSlotSync } from './useSlotSync'

/** `hidden` keeps the browser mounted but out of layout, so its slot (and native view) sizes to 0. */
export function BrowserPanel({ hidden = false }: { hidden?: boolean }) {
  const slot = useRef<HTMLDivElement>(null)
  const tabs = useBrowserStore((s) => s.tabs)
  const activeId = useBrowserStore((s) => s.activeId)
  const tab = useBrowserStore(activeTab)
  useEffect(() => {
    const offStore = startBrowserStore()
    const offScope = startBrowserScope()
    return () => {
      offScope()
      offStore()
    }
  }, [])
  useSlotSync(slot)
  useBrowserHotkeys()

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
      <div className="eva-browser-slot" data-testid="browser-slot" ref={slot}>
        {showCard ? <PageStateCard tab={tab} /> : null}
      </div>
    </section>
  )
}
