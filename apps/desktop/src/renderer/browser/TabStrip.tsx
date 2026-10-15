import { ActionIcon, Loader, Tooltip } from '@mantine/core'
import { IconPlus, IconX } from '@tabler/icons-react'
import type { TabState } from '@evaos/contract'
import { invoke } from '../ipc'

function label(t: TabState): string {
  if (t.title) return t.title
  if (t.url) return t.url.replace(/^[a-z]+:\/\//, '').replace(/\/$/, '')
  return 'New tab'
}

export function TabStrip({ tabs, activeId }: { tabs: TabState[]; activeId: string }) {
  return (
    <div className="eva-tab-strip" data-testid="tab-strip">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`eva-tab${t.id === activeId ? ' is-active' : ''}`}
          data-testid={`browser-tab-${t.id}`}
          onClick={() => void invoke('browser.activateTab', { tabId: t.id })}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              void invoke('browser.closeTab', { tabId: t.id })
            }
          }}
          onMouseDown={(e) => {
            if (e.button === 1) e.preventDefault()
          }}
        >
          {t.loading ? (
            <Loader size={12} />
          ) : t.favicon ? (
            <img className="eva-tab-icon" src={t.favicon} alt="" width={14} height={14} />
          ) : null}
          <span className="eva-label eva-tab-title">{label(t)}</span>
          <Tooltip label="Close tab" openDelay={400}>
            <ActionIcon
              variant="subtle"
              size={18}
              aria-label="Close tab"
              data-testid={`browser-tab-close-${t.id}`}
              className="eva-tab-close"
              onClick={(e) => {
                e.stopPropagation()
                void invoke('browser.closeTab', { tabId: t.id })
              }}
            >
              <IconX size={12} />
            </ActionIcon>
          </Tooltip>
        </div>
      ))}
      <Tooltip label="New tab" openDelay={400}>
        <ActionIcon
          variant="subtle"
          size={28}
          aria-label="New tab"
          data-testid="browser-tab-new"
          className="eva-tab-new"
          onClick={() => void invoke('browser.createTab', {})}
        >
          <IconPlus size={16} />
        </ActionIcon>
      </Tooltip>
    </div>
  )
}
