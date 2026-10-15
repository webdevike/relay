import { useEffect, useRef } from 'react'
import './browser.css'
import { AddressRow } from './AddressRow'
import { PageStateCard } from './PageStateCard'
import { TabStrip } from './TabStrip'
import { activeTab, startBrowserStore, useBrowserStore } from './browser-store'
import { useBrowserHotkeys } from './useBrowserHotkeys'
import { useSlotSync } from './useSlotSync'

export function BrowserPanel() {
  const slot = useRef<HTMLDivElement>(null)
  const tabs = useBrowserStore((s) => s.tabs)
  const activeId = useBrowserStore((s) => s.activeId)
  const tab = useBrowserStore(activeTab)
  useEffect(() => startBrowserStore(), [])
  useSlotSync(slot)
  useBrowserHotkeys()

  const showCard = tab !== undefined && (tab.blank || tab.error !== null)
  return (
    <section className="eva-browser" data-testid="browser-panel">
      <TabStrip tabs={tabs} activeId={activeId} />
      <AddressRow tab={tab} />
      <div className="eva-browser-slot" data-testid="browser-slot" ref={slot}>
        {showCard && tab ? <PageStateCard tab={tab} /> : null}
      </div>
    </section>
  )
}
