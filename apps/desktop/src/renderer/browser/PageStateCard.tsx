import { Button, Text, UnstyledButton } from '@mantine/core'
import { IconGlobe } from '@tabler/icons-react'
import { BLOCKED_URL_CODE } from '@evaos/browser-core/address'
import type { TabState } from '@evaos/contract'
import { invoke } from '../ipc'
import { useRecent } from '../tiling/recent'

/** How many recent pages a blank page lists. */
const SHOWN = 5

/** A blank page: quiet, the address field above has the focus; the pages opened last below. */
function BlankPage({ tabId }: { tabId: string }) {
  const recent = useRecent()
    .filter((item) => item.kind === 'url')
    .slice(0, SHOWN)
  return (
    <div className="eva-page-blank" data-testid="page-blank">
      <Text size="sm" c="dimmed">
        Type an address or search above.
      </Text>
      {recent.length > 0 ? (
        <div className="eva-page-recent" data-testid="page-recent">
          {recent.map((item) => (
            <UnstyledButton
              key={item.target}
              className="eva-page-recent-row"
              data-testid="page-recent-row"
              onClick={() => void invoke('browser.navigate', { tabId, input: item.target })}
            >
              <IconGlobe size={14} stroke={1.5} aria-hidden="true" />
              <Text span className="eva-page-recent-name">
                {item.name}
              </Text>
              <Text span className="eva-page-recent-where">
                {item.where}
              </Text>
            </UnstyledButton>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** The card over the slot: an error, or the blank page (also while the page's state loads). */
export function PageStateCard({ tabId, tab }: { tabId: string; tab: TabState | undefined }) {
  if (tab?.error?.code === BLOCKED_URL_CODE) {
    return (
      <div className="eva-page-card" data-testid="page-error">
        <h2 className="eva-heading">This address cannot be opened here</h2>
        <p className="eva-dim">
          Only web pages (http and https) open in this panel. {tab.error.host} was not loaded.
        </p>
      </div>
    )
  }
  if (tab?.error) {
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
  return tab?.blank ? <BlankPage tabId={tabId} /> : null
}
