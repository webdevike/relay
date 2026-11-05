import { useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Loader } from '@mantine/core'
import { IconGlobe, IconPin, IconPinnedOff, IconX } from '@tabler/icons-react'
import type { IDockviewPanelHeaderProps, IDockviewPanelProps } from 'dockview-react'
import { toolTabFromJson, type SubagentTab, type ToolTab } from '@evaos/shell-core'
import type { TabState } from '@evaos/contract'
import { useBrowserStore } from '../../browser/browser-store'
import { useChatStore } from '../../chat/chat-store'
import { useFrontChatPane } from '../../chat/front-chat'
import { SubagentStateIcon, subagentState, useMinute } from '../../chat/strips/SubagentChips'
import { useNamesVersion } from '../../eva/names-store'
import { EvaMenu } from '../../overlay'
import { paneTabIcon, paneTabTitle } from '../pane-tab-meta'
import { useAttachContent } from '../tab-content'
import { activateTab, closeTab, isPinnedTool, setPinned, useTiling } from '../tiling-store'
import { usePanelActive } from './panel-hooks'
import './pinned.css'

/** A tool tab's content: its node from the content host (tab-content), never remounted here. */
export function ToolPanel({ api }: IDockviewPanelProps) {
  const body = useRef<HTMLDivElement>(null)
  useAttachContent(body, api.id)
  return <div className="eva-pane-body" ref={body} />
}

/** A running subagent's tab spins like its chip while the chat in front is its own. */
function SubagentGlyph({ tab }: { tab: SubagentTab }) {
  const now = useMinute()
  const front = useFrontChatPane()
  const subagent = useChatStore((s) => {
    const pane = s.panes[front]
    if (!pane || pane.file !== tab.session) return undefined
    return pane.extras.subagents.find((a) => a.name === tab.name)
  })
  if (!subagent) {
    const Icon = paneTabIcon(tab)
    return <Icon size={14} stroke={1.5} />
  }
  return <SubagentStateIcon state={subagentState(subagent, now)} />
}

/** A page tab's glyph: a spinner while it loads, its favicon, else a globe. */
function WebGlyph({ page }: { page: TabState | undefined }) {
  if (page?.loading) return <Loader size={12} />
  if (page?.favicon) {
    return <img className="eva-web-favicon" src={page.favicon} alt="" width={14} height={14} />
  }
  return <IconGlobe size={14} stroke={1.5} />
}

/** Who opened a page (a session or a helper, not the assistant itself): a dim initial. */
function OwnerMark({ name }: { name: string }) {
  const initial = /[\p{L}\p{N}]/u.exec(name)?.[0]?.toUpperCase() ?? '·'
  return (
    <span className="eva-web-owner" title={`Opened by ${name}`} data-testid="pane-tab-owner">
      {initial}
    </span>
  )
}

/**
 * A tool tab in its pane's strip: icon, title, and a close button that keeps its room. A pinned
 * tab (in every workspace) is its icon alone, like a pinned app tab. Right-click pins or closes.
 */
export function ToolTabView({ api, params }: IDockviewPanelHeaderProps<{ tab?: ToolTab }>) {
  useNamesVersion()
  useTiling((s) => s.rev)
  const active = usePanelActive(api)
  const pinned = useTiling((s) => isPinnedTool(s, api.id))
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const tab = toolTabFromJson(params.tab)
  const page = useBrowserStore((s) => (tab?.kind === 'web' ? s.byId[tab.id] : undefined))
  if (!tab) return null
  const id = api.id
  const title = paneTabTitle(tab)
  const Icon = paneTabIcon(tab)
  const onKey = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    activateTab(id)
  }
  return (
    <>
      <div
        className={pinned ? 'eva-pane-tab eva-pane-tab-pinned' : 'eva-pane-tab'}
        data-active={active || undefined}
        data-pinned={pinned || undefined}
        data-pane-tab
        data-testid={`pane-tab-${id}`}
        title={title}
        onKeyDown={onKey}
        onAuxClick={(e) => {
          if (e.button !== 1 || pinned) return
          e.preventDefault()
          closeTab(id)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        {tab.kind === 'subagent' ? (
          <SubagentGlyph tab={tab} />
        ) : tab.kind === 'web' ? (
          <WebGlyph page={page} />
        ) : (
          <Icon size={14} stroke={1.5} />
        )}
        {pinned ? null : (
          <>
            <span className="eva-pane-tab-title">{title}</span>
            {page?.openedBy ? <OwnerMark name={page.openedBy} /> : null}
            <button
              type="button"
              className="eva-pane-tab-close"
              tabIndex={-1}
              aria-label={`Close ${title}`}
              data-testid={`pane-tab-close-${id}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                closeTab(id)
              }}
            >
              <IconX size={12} stroke={1.5} />
            </button>
          </>
        )}
      </div>
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
        <EvaMenu.Dropdown data-testid={`pane-tab-menu-${id}`}>
          <EvaMenu.Item
            data-testid="pane-tab-menu-pin"
            leftSection={
              pinned ? <IconPinnedOff size={16} stroke={1.5} /> : <IconPin size={16} stroke={1.5} />
            }
            onClick={() => setPinned(id, !pinned)}
          >
            {pinned ? 'Unpin tab' : 'Pin to every workspace'}
          </EvaMenu.Item>
          <EvaMenu.Item
            data-testid="pane-tab-menu-close"
            leftSection={<IconX size={16} stroke={1.5} />}
            onClick={() => closeTab(id)}
          >
            Close tab
          </EvaMenu.Item>
        </EvaMenu.Dropdown>
      </EvaMenu>
    </>
  )
}
