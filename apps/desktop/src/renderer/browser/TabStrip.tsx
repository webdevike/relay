import { useState } from 'react'
import { ActionIcon, Loader, Tooltip } from '@mantine/core'
import { IconPin, IconPinnedOff, IconPlus, IconX } from '@tabler/icons-react'
import type { TabState } from '@evaos/contract'
import { invoke } from '../ipc'
import { EvaMenu } from '../overlay'

function label(t: TabState): string {
  if (t.title) return t.title
  if (t.url) return t.url.replace(/^[a-z]+:\/\//, '').replace(/\/$/, '')
  return 'New tab'
}

/** Pinned tabs (shown in every scope) come first, then the current scope's own tabs. */
export function TabStrip({ tabs, activeId }: { tabs: TabState[]; activeId: string }) {
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const menuTab = menu ? tabs.find((t) => t.id === menu.id) : undefined
  return (
    <div className="eva-tab-strip" data-testid="tab-strip">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`eva-tab${t.id === activeId ? ' is-active' : ''}`}
          data-testid={`browser-tab-${t.id}`}
          data-pinned={t.pinned ? 'true' : undefined}
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
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ id: t.id, x: e.clientX, y: e.clientY })
          }}
        >
          {t.pinned ? (
            <IconPin
              className="eva-tab-pin"
              size={12}
              stroke={1.5}
              aria-label="Pinned"
              data-testid={`browser-tab-pin-${t.id}`}
            />
          ) : null}
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
      <EvaMenu
        opened={menuTab !== undefined}
        onChange={(o) => {
          if (!o) setMenu(null)
        }}
        width={180}
        position="bottom-start"
        offset={0}
      >
        <EvaMenu.Target>
          <span
            className="eva-tab-menu-anchor"
            style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
            aria-hidden
          />
        </EvaMenu.Target>
        <EvaMenu.Dropdown data-testid="browser-tab-menu">
          {menuTab ? (
            <EvaMenu.Item
              data-testid="browser-tab-menu-pin"
              leftSection={
                menuTab.pinned ? (
                  <IconPinnedOff size={16} stroke={1.5} />
                ) : (
                  <IconPin size={16} stroke={1.5} />
                )
              }
              onClick={() =>
                void invoke('browser.pinTab', { tabId: menuTab.id, pinned: !menuTab.pinned })
              }
            >
              {menuTab.pinned ? 'Unpin tab' : 'Pin tab'}
            </EvaMenu.Item>
          ) : null}
        </EvaMenu.Dropdown>
      </EvaMenu>
    </div>
  )
}
