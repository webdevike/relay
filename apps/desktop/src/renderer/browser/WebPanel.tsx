import { useEffect, useRef, type CSSProperties } from 'react'
import { useSelector } from '@xstate/react'
import { isAppSwitchUrl } from '@evaos/browser-core/app-switch'
import './browser.css'
import { AddressRow } from './AddressRow'
import { AgentCaption, agentOp } from './AgentCaption'
import { AppSwitcher } from './AppSwitcher'
import { PageStateCard } from './PageStateCard'
import { PasskeyBar } from './PasskeyBar'
import { readPages, useWebPage } from './browser-store'
import { useWebSlot } from './useSlotSync'
import { DesignInspector } from './design/DesignInspector'
import { designActorOf } from './design/design-runtime'

/**
 * One web page's tab: its address row, the passkey bar, and the slot its native view sits over
 * while the tab is in front of a pane on screen (`visible`); otherwise the view parks. A page an
 * agent drives sits in the agent's soft colored ring with its caption row underneath. In Design
 * Mode the inspector takes a column beside the page.
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
  const agent = tab?.agent && tab.agent.status !== 'idle' ? tab.agent : null
  const designing = useSelector(designActorOf(tabId), (s) => s.matches('on'))
  return (
    <section className="eva-browser" data-testid="web-panel" data-tab-id={tabId}>
      <AddressRow tabId={tabId} tab={tab} visible={visible}>
        {tab && isAppSwitchUrl(tab.url) ? <AppSwitcher key={tab.id} tab={tab} /> : null}
      </AddressRow>
      {tab?.passkey && !showCard ? <PasskeyBar tab={tab} /> : null}
      <div className="eva-browser-body">
        <div
          className="eva-browser-frame eva-agent-host"
          data-agent={agent?.status}
          data-testid="browser-frame"
          style={agent ? ({ '--eva-agent': agent.color } as CSSProperties) : undefined}
        >
          <div className="eva-browser-slot" data-testid="browser-slot" ref={slot}>
            {showCard ? <PageStateCard tabId={tabId} tab={tab} /> : null}
          </div>
          {agent ? (
            <AgentCaption agent={agent} subject="tab" onOp={(op) => agentOp(tabId, op)} />
          ) : null}
        </div>
        {designing ? <DesignInspector tabId={tabId} visible={visible} /> : null}
      </div>
    </section>
  )
}
