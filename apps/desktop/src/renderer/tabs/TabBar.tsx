import './tabs.css'
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { ActionIcon, Kbd, Tooltip } from '@mantine/core'
import {
  IconAsterisk,
  IconBrain,
  IconCalendar,
  IconCalendarTime,
  IconFile,
  IconFlame,
  IconHelp,
  IconInbox,
  IconLayoutDashboard,
  IconLayoutSidebar,
  IconLayoutSidebarRight,
  IconListCheck,
  IconMessage,
  IconPin,
  IconPlus,
  IconSettings,
  IconUsers,
  IconX,
  type Icon,
} from '@tabler/icons-react'
import { EvaMenu } from '../overlay'
import { togglePanel, toggleSidebar, useLayout } from '../shell/layout-store'
import { tabIconName, tabTitle } from './tab-meta'
import { activate, close, closeOthersOf, newChatTab, togglePinOf, useTabs } from './tabs-store'

const ICONS: Record<string, Icon> = {
  IconLayoutDashboard,
  IconInbox,
  IconMessage,
  IconCalendarTime,
  IconFlame,
  IconUsers,
  IconCalendar,
  IconListCheck,
  IconBrain,
  IconFile,
  IconSettings,
  IconHelp,
}

export const FOLDED_LABEL =
  'Sidebar hidden to fit the window. Widen the window or close the panel to bring it back.'

function Chord({ children }: { children: string }) {
  return <Kbd size="xs">{children}</Kbd>
}

function withKbd(label: string, chord: string) {
  return (
    <span className="eva-tip">
      {label} <Chord>{chord}</Chord>
    </span>
  )
}

export function TabBar() {
  const tabs = useTabs((s) => s.tabs)
  const state = useLayout((s) => s.state)
  const panelOpen = useLayout((s) => s.panelOpen)
  const [menu, setMenu] = useState<{ id: number; x: number; y: number } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const activeId = tabs.list[tabs.active]?.id

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[role=tab][data-active=true]')
    el?.scrollIntoView?.({ inline: 'nearest', block: 'nearest', behavior: 'smooth' })
  }, [activeId])

  const sidebarLabel =
    state === 'open' ? 'Hide sidebar' : state === 'hidden' ? 'Show sidebar' : FOLDED_LABEL
  const sidebarTip = state === 'folded' ? FOLDED_LABEL : withKbd(sidebarLabel, '⌘B')

  const onKey = (e: KeyboardEvent<HTMLElement>, id: number): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      activate(id)
      return
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const all = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role=tab]') ?? [])
    const at = all.indexOf(e.currentTarget)
    const next = all[at + (e.key === 'ArrowRight' ? 1 : -1)]
    if (next) {
      e.preventDefault()
      next.focus()
    }
  }

  const onAux = (e: MouseEvent, id: number, pinned: boolean): void => {
    if (e.button !== 1) return
    e.preventDefault()
    if (!pinned) close(id)
  }

  const menuTab = menu ? tabs.list.find((t) => t.id === menu.id) : undefined
  const othersExist = menuTab ? tabs.list.some((t) => t.id !== menuTab.id && !t.pinned) : false

  return (
    <div
      className="eva-tabbar"
      data-testid="tabbar"
      data-lead-in={state !== 'open' ? 'true' : 'false'}
    >
      <Tooltip label={sidebarTip} position="bottom" openDelay={400}>
        <ActionIcon
          variant="subtle"
          size={28}
          className="eva-tabbar-btn"
          data-testid="sidebar-toggle"
          aria-label={sidebarLabel}
          aria-pressed={state === 'open'}
          onClick={() => toggleSidebar()}
        >
          <IconLayoutSidebar size={16} stroke={1.5} />
        </ActionIcon>
      </Tooltip>

      <div className="eva-tabs-scroll" ref={listRef} role="tablist" aria-label="Open pages">
        {tabs.list.map((tab, ix) => {
          const Glyph = ICONS[tabIconName(tab.here)] ?? IconAsterisk
          const title = tabTitle(tab.here)
          const isActive = ix === tabs.active
          const common = {
            role: 'tab',
            'aria-selected': isActive,
            'aria-label': title,
            'data-active': isActive,
            tabIndex: isActive ? 0 : -1,
            onClick: () => activate(tab.id),
            onKeyDown: (e: KeyboardEvent<HTMLElement>) => onKey(e, tab.id),
            onAuxClick: (e: MouseEvent) => onAux(e, tab.id, tab.pinned),
            onContextMenu: (e: MouseEvent) => {
              e.preventDefault()
              setMenu({ id: tab.id, x: e.clientX, y: e.clientY })
            },
          }
          if (tab.pinned) {
            return (
              <Tooltip key={tab.id} label={title} position="bottom" openDelay={400}>
                <div
                  {...common}
                  className="eva-tab eva-tab-pinned"
                  data-testid={`tab-pinned-${tab.id}`}
                >
                  <Glyph size={16} stroke={1.5} />
                </div>
              </Tooltip>
            )
          }
          return (
            <Tooltip key={tab.id} label={title} position="bottom" openDelay={600}>
              <div {...common} className="eva-tab" data-testid={`tab-${tab.id}`}>
                <Glyph size={14} stroke={1.5} />
                <span className="eva-label eva-tab-title">{title}</span>
                <button
                  type="button"
                  className="eva-tab-close"
                  tabIndex={-1}
                  data-testid={`tab-close-${tab.id}`}
                  aria-label="Close tab"
                  onClick={(e) => {
                    e.stopPropagation()
                    close(tab.id)
                  }}
                  onAuxClick={(e) => e.stopPropagation()}
                >
                  <IconX size={14} stroke={1.5} />
                </button>
              </div>
            </Tooltip>
          )
        })}
        <Tooltip label={withKbd('New tab', '⌘T')} position="bottom" openDelay={400}>
          <ActionIcon
            variant="subtle"
            size={28}
            className="eva-tabbar-btn"
            data-testid="tab-new"
            aria-label="New tab"
            onClick={() => newChatTab()}
          >
            <IconPlus size={16} stroke={1.5} />
          </ActionIcon>
        </Tooltip>
      </div>

      <div className="eva-tabbar-spacer" data-testid="tabbar-drag" />

      <Tooltip
        label={withKbd(panelOpen ? 'Close panel' : 'Open panel', '⌘⇧B')}
        position="bottom-end"
        openDelay={400}
      >
        <ActionIcon
          variant="subtle"
          size={28}
          className="eva-tabbar-btn"
          data-testid="panel-toggle"
          aria-label={panelOpen ? 'Close panel' : 'Open panel'}
          aria-pressed={panelOpen}
          onClick={() => togglePanel()}
        >
          <IconLayoutSidebarRight size={16} stroke={1.5} />
        </ActionIcon>
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
        <EvaMenu.Target>
          <span
            className="eva-tab-menu-anchor"
            style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
            aria-hidden
          />
        </EvaMenu.Target>
        <EvaMenu.Dropdown data-testid="tab-menu">
          {menuTab ? (
            <>
              <EvaMenu.Item
                data-testid="tab-menu-pin"
                leftSection={<IconPin size={16} stroke={1.5} />}
                onClick={() => togglePinOf(menuTab.id)}
              >
                {menuTab.pinned ? 'Unpin tab' : 'Pin tab'}
              </EvaMenu.Item>
              <EvaMenu.Item
                data-testid="tab-menu-close"
                leftSection={<IconX size={16} stroke={1.5} />}
                disabled={menuTab.pinned}
                onClick={() => close(menuTab.id)}
              >
                Close tab
              </EvaMenu.Item>
              <EvaMenu.Item
                data-testid="tab-menu-close-others"
                leftSection={<IconX size={16} stroke={1.5} />}
                disabled={!othersExist}
                onClick={() => closeOthersOf(menuTab.id)}
              >
                Close others
              </EvaMenu.Item>
            </>
          ) : null}
        </EvaMenu.Dropdown>
      </EvaMenu>
    </div>
  )
}
