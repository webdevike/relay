import { useCallback, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { Tooltip } from '@mantine/core'
import { IconAsterisk, IconPin, IconX } from '@tabler/icons-react'
import type { IDockviewPanelHeaderProps, IDockviewPanelProps } from 'dockview-react'
import { appTabOf, switchTo, type Place } from '@evaos/shell-core'
import { useScopeBadges } from '../../agent/scope'
import { AgentPortrait } from '../../assistants/AgentPortrait'
import { agentFile, agentIdOf, useAssistants } from '../../assistants/assistants-store'
import { TabChat } from '../../chat/ChatPane'
import { useNamesVersion } from '../../eva/names-store'
import { EvaMenu } from '../../overlay'
import { InToolPaneContext, ReplacePlaceContext } from '../../pages/place-host'
import { PageView } from '../../pages/PageRouter'
import { MainHeader } from '../../shell/MainHeader'
import { PAGE_ICONS } from '../../tabs/tab-icons'
import { tabIconName, tabTitle } from '../../tabs/tab-meta'
import {
  activeTabId,
  closeOthersOf,
  replaceTabPlace,
  togglePinOf,
  updateTabs,
  useTabs,
} from '../../tabs/tabs-store'
import { workspaceOfTab } from '../../tabs/workspace-of'
import { closeAppTab, useTiling } from '../tiling-store'
import { usePanelActive, usePanelVisible, usePaneOf } from './panel-hooks'

/**
 * An app tab's content: its chat (a chat, or an assistant's thread) or its page with the page
 * header, while it is in front of its pane. A page settles what it shows (Canvas picking the
 * newest board) in this tab, not the active one.
 */
export function AppPanel({ api }: IDockviewPanelProps) {
  const id = appTabOf(api.id) ?? -1
  const place = useTabs((s) => s.tabs.list.find((t) => t.id === id)?.here ?? null)
  const front = useTabs((s) => activeTabId(s) === id)
  const visible = usePanelVisible(api)
  const pane = usePaneOf(api.id)
  const lead = useTiling((s) => pane !== null && s.lead === pane)
  const thread = useAssistants((s) => (place ? agentFile(s, place) : null))
  const replace = useCallback((p: Place) => replaceTabPlace(p, id), [id])
  if (!place || !visible) return null
  const isChat = place.page === 'chat' || thread !== null
  return (
    <div
      className="eva-app-panel"
      data-testid={front ? 'main-card' : `app-panel-${id}`}
      data-app-tab={id}
    >
      {isChat ? (
        <TabChat tab={id} place={place} lead={lead} />
      ) : (
        <>
          <MainHeader place={place} lead={lead} />
          <ReplacePlaceContext.Provider value={replace}>
            <InToolPaneContext.Provider value={!lead}>
              <PageView place={place} />
            </InToolPaneContext.Provider>
          </ReplacePlaceContext.Provider>
        </>
      )}
    </div>
  )
}

/**
 * An app tab in its pane's strip, as the tab bar drew it: the page's glyph (an assistant's
 * portrait), its title, a close button that keeps its room, an agent's badge; pinned tabs are
 * the glyph alone. Right-click pins or closes; a middle click closes.
 */
export function AppTab({ api }: IDockviewPanelHeaderProps) {
  useNamesVersion()
  const id = appTabOf(api.id) ?? -1
  const tab = useTabs((s) => s.tabs.list.find((t) => t.id === id) ?? null)
  const others = useTabs((s) => s.tabs.list.some((t) => t.id !== id && !t.pinned))
  const active = usePanelActive(api)
  const badges = useScopeBadges()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  if (!tab) return null
  const agent = agentIdOf(tab.here)
  const Glyph = PAGE_ICONS[tabIconName(tab.here)] ?? IconAsterisk
  const title = tabTitle(tab.here)
  // What an agent did in this tab's workspace while Isaac was elsewhere (agent/scope.ts).
  const badge = badges[workspaceOfTab(tab)] ?? null
  const label = badge ? `${title} · ${badge}` : title
  const glyph =
    agent !== null ? (
      <AgentPortrait id={agent} className="eva-tab-portrait" />
    ) : (
      <Glyph size={tab.pinned ? 16 : 14} stroke={1.5} />
    )
  const dot = badge ? (
    <span className="eva-tab-badge" data-testid={`tab-badge-${tab.id}`} aria-hidden />
  ) : null
  const onKey = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    updateTabs((t) => switchTo(t, id))
  }
  const onAux = (e: MouseEvent): void => {
    if (e.button !== 1) return
    e.preventDefault()
    if (!tab.pinned) closeAppTab(id)
  }
  return (
    <>
      <Tooltip label={label} position="bottom" openDelay={tab.pinned ? 400 : 600}>
        <div
          className={tab.pinned ? 'eva-tab eva-tab-pinned' : 'eva-tab'}
          data-testid={tab.pinned ? `tab-pinned-${tab.id}` : `tab-${tab.id}`}
          data-active={active}
          data-app-tab={tab.id}
          aria-label={label}
          onKeyDown={onKey}
          onAuxClick={onAux}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setMenu({ x: e.clientX, y: e.clientY })
          }}
        >
          {glyph}
          {tab.pinned ? null : (
            <>
              <span className="eva-label eva-tab-title">{title}</span>
              <button
                type="button"
                className="eva-tab-close"
                tabIndex={-1}
                data-testid={`tab-close-${tab.id}`}
                aria-label="Close tab"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  closeAppTab(tab.id)
                }}
                onAuxClick={(e) => e.stopPropagation()}
              >
                <IconX size={14} stroke={1.5} />
              </button>
            </>
          )}
          {dot}
        </div>
      </Tooltip>
      <EvaMenu
        opened={menu !== null}
        onChange={(o) => {
          if (!o) setMenu(null)
        }}
        width={200}
        position="bottom-start"
        offset={0}
      >
        {/* At the pointer, outside the strip: dockview's tab strip clips, and a clipped anchor
            hides its menu. */}
        {createPortal(
          <EvaMenu.Target>
            <span
              className="eva-tab-menu-anchor"
              style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
              aria-hidden
            />
          </EvaMenu.Target>,
          document.body,
        )}
        <EvaMenu.Dropdown data-testid="tab-menu">
          <EvaMenu.Item
            data-testid="tab-menu-pin"
            leftSection={<IconPin size={16} stroke={1.5} />}
            onClick={() => togglePinOf(tab.id)}
          >
            {tab.pinned ? 'Unpin tab' : 'Pin tab'}
          </EvaMenu.Item>
          <EvaMenu.Item
            data-testid="tab-menu-close"
            leftSection={<IconX size={16} stroke={1.5} />}
            disabled={tab.pinned}
            onClick={() => closeAppTab(tab.id)}
          >
            Close tab
          </EvaMenu.Item>
          <EvaMenu.Item
            data-testid="tab-menu-close-others"
            leftSection={<IconX size={16} stroke={1.5} />}
            disabled={!others}
            onClick={() => closeOthersOf(tab.id)}
          >
            Close others
          </EvaMenu.Item>
        </EvaMenu.Dropdown>
      </EvaMenu>
    </>
  )
}
