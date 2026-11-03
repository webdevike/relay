import { memo, useRef, useState, type KeyboardEvent } from 'react'
import { ActionIcon, Kbd, Tooltip } from '@mantine/core'
import {
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconFiles,
  IconGlobe,
  IconLayoutColumns,
  IconLayoutRows,
  IconListCheck,
  IconPhotoSpark,
  IconPlus,
  IconSchema,
  IconX,
} from '@tabler/icons-react'
import { findPane, placeOf, tabId, type PaneTab, type SubagentTab } from '@evaos/shell-core'
import { useChatStore } from '../chat/chat-store'
import { PANE_ID } from '../chat/open-chat'
import { SubagentStateIcon, subagentState, useMinute } from '../chat/strips/SubagentChips'
import { useNamesVersion } from '../eva/names-store'
import { EvaMenu } from '../overlay'
import { paneTabIcon, paneTabTitle } from './pane-tab-meta'
import { useAttachContent } from './tab-content'
import { startTabDrag } from './tab-drag'
import {
  activateTab,
  closePaneById,
  closeTab,
  openTab,
  splitAt,
  useTiling,
  zoomPane,
} from './tiling-store'

function tip(label: string, chord?: string) {
  return (
    <span className="eva-tip">
      {label}
      {chord ? <Kbd size="xs">{chord}</Kbd> : null}
    </span>
  )
}

/** What the + menu adds to this pane (moved here when it is open elsewhere). */
const ADDABLE: Array<{ label: string; Icon: typeof IconGlobe; tab: PaneTab }> = [
  { label: 'Browser', Icon: IconGlobe, tab: { kind: 'browser' } },
  { label: 'Files', Icon: IconFiles, tab: { kind: 'files' } },
  { label: 'Test Bench', Icon: IconListCheck, tab: { kind: 'page', place: placeOf('test-bench') } },
  { label: 'Canvas', Icon: IconSchema, tab: { kind: 'page', place: placeOf('canvas') } },
  { label: 'Studio', Icon: IconPhotoSpark, tab: { kind: 'page', place: placeOf('studio') } },
]

/** A running subagent's tab spins like its chip while the chat in front is its own. */
function SubagentGlyph({ tab }: { tab: SubagentTab }) {
  const now = useMinute()
  const subagent = useChatStore((s) => {
    const pane = s.panes[PANE_ID]
    if (!pane || pane.file !== tab.session) return undefined
    return pane.extras.subagents.find((a) => a.name === tab.name)
  })
  if (!subagent) {
    const Icon = paneTabIcon(tab)
    return <Icon size={14} stroke={1.5} />
  }
  return <SubagentStateIcon state={subagentState(subagent, now)} />
}

function PaneTabButton({ tab, active, paneId }: { tab: PaneTab; active: boolean; paneId: string }) {
  const id = tabId(tab)
  const title = paneTabTitle(tab)
  const Icon = paneTabIcon(tab)
  const onKey = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      activateTab(id)
      return
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const strip = e.currentTarget.parentElement
    const all = [...(strip?.querySelectorAll<HTMLElement>('[role=tab]') ?? [])]
    const next = all[all.indexOf(e.currentTarget) + (e.key === 'ArrowRight' ? 1 : -1)]
    if (next) {
      e.preventDefault()
      next.focus()
    }
  }
  return (
    <div
      role="tab"
      aria-selected={active}
      aria-label={title}
      tabIndex={active ? 0 : -1}
      className="eva-pane-tab"
      data-active={active || undefined}
      data-pane-tab
      data-testid={`pane-tab-${id}`}
      title={title}
      onPointerDown={(e) => startTabDrag(e, { tab, title })}
      onClick={() => activateTab(id)}
      onAuxClick={(e) => {
        if (e.button !== 1) return
        e.preventDefault()
        closeTab(id)
      }}
      onKeyDown={onKey}
      data-pane={paneId}
    >
      {tab.kind === 'subagent' ? <SubagentGlyph tab={tab} /> : <Icon size={14} stroke={1.5} />}
      <span className="eva-pane-tab-title">{title}</span>
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
    </div>
  )
}

/**
 * A tool pane: its tab strip (drag a tab to another pane's edge to split, onto its strip or
 * middle to join), the + menu, split, maximize and close, then the tab in front.
 */
export const ToolPane = memo(function ToolPane({ id }: { id: string }) {
  useNamesVersion()
  const pane = useTiling((s) => findPane(s.tiling, id))
  const zoomed = useTiling((s) => s.tiling.zoom === id)
  const [menu, setMenu] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  useAttachContent(body, pane?.active ?? null)
  if (!pane) return null
  return (
    <section className="eva-card eva-pane-card" data-testid={`pane-${id}`}>
      <header className="eva-pane-header" data-testid={`pane-header-${id}`}>
        <div className="eva-pane-tabs" role="tablist" aria-label="Pane tabs" data-pane-tabs>
          {pane.tabs.map((tab) => (
            <PaneTabButton
              key={tabId(tab)}
              tab={tab}
              active={pane.active === tabId(tab)}
              paneId={id}
            />
          ))}
        </div>
        <EvaMenu opened={menu} onChange={setMenu} position="bottom-end" width={200}>
          <EvaMenu.Target>
            <Tooltip
              label={tip('Add a tab or split')}
              position="bottom"
              openDelay={400}
              disabled={menu}
            >
              <ActionIcon
                variant="subtle"
                className="eva-header-btn"
                aria-label="Add a tab or split"
                data-testid={`pane-add-${id}`}
              >
                <IconPlus size={16} stroke={1.5} />
              </ActionIcon>
            </Tooltip>
          </EvaMenu.Target>
          <EvaMenu.Dropdown data-testid={`pane-add-menu-${id}`}>
            {ADDABLE.map(({ label, Icon, tab }) => (
              <EvaMenu.Item
                key={label}
                leftSection={<Icon size={16} stroke={1.5} />}
                onClick={() => openTab(tab, id)}
              >
                {label}
              </EvaMenu.Item>
            ))}
            <EvaMenu.Divider />
            <EvaMenu.Item
              data-testid={`pane-split-${id}`}
              leftSection={<IconLayoutColumns size={16} stroke={1.5} />}
              rightSection={<Kbd size="xs">⌘\\</Kbd>}
              onClick={() => splitAt(id, 'right')}
            >
              Split right
            </EvaMenu.Item>
            <EvaMenu.Item
              data-testid={`pane-split-down-${id}`}
              leftSection={<IconLayoutRows size={16} stroke={1.5} />}
              rightSection={<Kbd size="xs">⇧⌘\\</Kbd>}
              onClick={() => splitAt(id, 'down')}
            >
              Split down
            </EvaMenu.Item>
            {zoomed ? null : (
              <EvaMenu.Item
                data-testid={`pane-zoom-${id}`}
                leftSection={<IconArrowsMaximize size={16} stroke={1.5} />}
                rightSection={<Kbd size="xs">⌥⌘↩</Kbd>}
                onClick={() => zoomPane(id, true)}
              >
                Maximize
              </EvaMenu.Item>
            )}
          </EvaMenu.Dropdown>
        </EvaMenu>
        {zoomed ? (
          <Tooltip label={tip('Restore panes', '⌥⌘↩')} position="bottom" openDelay={400}>
            <ActionIcon
              variant="subtle"
              className="eva-header-btn"
              aria-label="Restore panes"
              aria-pressed
              data-testid={`pane-zoom-${id}`}
              onClick={() => zoomPane(id, false)}
            >
              <IconArrowsMinimize size={16} stroke={1.5} />
            </ActionIcon>
          </Tooltip>
        ) : null}
        <Tooltip label={tip('Close pane', '⌥⌘W')} position="bottom-end" openDelay={400}>
          <ActionIcon
            variant="subtle"
            className="eva-header-btn"
            aria-label="Close pane"
            data-testid={`pane-close-${id}`}
            onClick={() => closePaneById(id)}
          >
            <IconX size={16} stroke={1.5} />
          </ActionIcon>
        </Tooltip>
      </header>
      <div className="eva-pane-body" ref={body} data-testid={`pane-body-${id}`} />
    </section>
  )
})
