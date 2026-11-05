import { useEffect, useRef } from 'react'
import { isAppSwitchUrl } from '@evaos/browser-core/app-switch'
import './browser.css'
import { AddressRow } from './AddressRow'
import { AppSwitcher } from './AppSwitcher'
import { PageStateCard } from './PageStateCard'
import { PasskeyBar } from './PasskeyBar'
import { readPages, useWebPage } from './browser-store'
import { useWebSlot } from './useSlotSync'

/**
 * One web page's tab: its address row, the passkey bar, and the slot its native view sits over
 * while the tab is in front of a pane on screen (`visible`); otherwise the view parks.
 */
export function WebPanel({ tabId, visible }: { tabId: string; visible: boolean }) {
  const slot = useRef<HTMLDivElement>(null)
  const tab = useWebPage(tabId)
  useWebSlot(slot, tabId, visible)
  // A page of another browser scope (not in the host's list on screen) is read by id.
  useEffect(() => {
    if (visible && !tab) void readPages([tabId])
  }, [visible, tab, tabId])

  const showCard = tab === undefined || tab.blank || tab.error !== null
  return (
    <section className="eva-browser" data-testid="web-panel" data-tab-id={tabId}>
      <AddressRow tabId={tabId} tab={tab} visible={visible}>
        {tab && isAppSwitchUrl(tab.url) ? <AppSwitcher key={tab.id} tab={tab} /> : null}
      </AddressRow>
      {tab?.passkey && !showCard ? <PasskeyBar tab={tab} /> : null}
      <div className="eva-browser-slot" data-testid="browser-slot" ref={slot}>
        {showCard ? <PageStateCard tabId={tabId} tab={tab} /> : null}
      </div>
    </section>
  )
}
