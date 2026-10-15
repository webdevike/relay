import { Button } from '@mantine/core'
import type { TabState } from '@evaos/contract'
import { invoke } from '../ipc'

export function PageStateCard({ tab }: { tab: TabState }) {
  if (tab.error) {
    return (
      <div className="eva-page-card" data-testid="page-error">
        <h2 className="eva-heading">This page could not be loaded</h2>
        <p className="eva-dim">
          {tab.error.host} did not respond or refused the connection. Check the address and try
          again.
        </p>
        <Button variant="default" onClick={() => void invoke('browser.reload', { tabId: tab.id })}>
          Try again
        </Button>
      </div>
    )
  }
  return (
    <div className="eva-page-card" data-testid="page-blank">
      <h2 className="eva-heading">New tab</h2>
      <p className="eva-dim">Type a web address, a search, or a local port such as 3000.</p>
    </div>
  )
}
