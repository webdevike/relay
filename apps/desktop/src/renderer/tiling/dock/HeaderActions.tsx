import { useState } from 'react'
import { ActionIcon, Kbd, Tooltip } from '@mantine/core'
import {
  IconArrowLeft,
  IconArrowRight,
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
import type { IDockviewHeaderActionsProps } from 'dockview-react'
import { appTabOf, placeOf, type Place, type ToolTab } from '@evaos/shell-core'
import { EvaMenu } from '../../overlay'
import { useLayout } from '../../shell/layout-store'
import { goBack, goForward, useTabs } from '../../tabs/tabs-store'
import {
  closePaneById,
  newChatTabIn,
  openPlaceInPane,
  openTab,
  splitAt,
  useTiling,
  zoomPane,
  type PaneView,
} from '../tiling-store'

function tip(label: string, chord?: string) {
  return (
    <span className="eva-tip">
      {label}
      {chord ? <Kbd size="xs">{chord}</Kbd> : null}
    </span>
  )
}

function usePane(id: string): PaneView | null {
  return useTiling((s) => s.panes.find((p) => p.id === id) ?? null)
}

/**
 * Before the tabs: room for the window's traffic lights when this pane sits top-left with the
 * sidebar away, then Back and Forward through the history of the app tab in front.
 */
export function PrefixActions({ group }: IDockviewHeaderActionsProps) {
  const pane = usePane(group.id)
  const sidebar = useLayout((s) => s.state)
  const front = pane?.active === null || !pane ? null : appTabOf(pane.active)
  const history = useTabs((s) => {
    const tab = front === null ? undefined : s.tabs.list.find((t) => t.id === front)
    return { back: (tab?.back.length ?? 0) > 0, forward: (tab?.forward.length ?? 0) > 0 }
  })
  const lead = useTiling((s) => s.lead === group.id)
  const topLeft = pane?.rect !== null && pane?.rect?.x === 0 && pane.rect.y === 0
  if (!pane) return null
  const room = sidebar !== 'open' && topLeft
  return (
    <div className="eva-dock-prefix" data-lead-in={room || undefined}>
      {pane.app ? (
        <>
          <Tooltip label={tip('Back', '⌘[')} position="bottom" openDelay={400}>
            <ActionIcon
              variant="subtle"
              className="eva-tabbar-btn"
              data-testid={lead ? 'tab-back' : `tab-back-${group.id}`}
              aria-label="Back"
              disabled={!history.back || front === null}
              onClick={() => front !== null && goBack(front)}
            >
              <IconArrowLeft size={16} stroke={1.5} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={tip('Forward', '⌘]')} position="bottom" openDelay={400}>
            <ActionIcon
              variant="subtle"
              className="eva-tabbar-btn"
              data-testid={lead ? 'tab-forward' : `tab-forward-${group.id}`}
              aria-label="Forward"
              disabled={!history.forward || front === null}
              onClick={() => front !== null && goForward(front)}
            >
              <IconArrowRight size={16} stroke={1.5} />
            </ActionIcon>
          </Tooltip>
        </>
      ) : null}
    </div>
  )
}

/** Right after the tabs of a pane holding app tabs: a new chat tab there. */
export function LeftActions({ group }: IDockviewHeaderActionsProps) {
  const pane = usePane(group.id)
  const lead = useTiling((s) => s.lead === group.id)
  if (!pane?.app) return null
  return (
    <Tooltip label={tip('New tab', '⌘T')} position="bottom" openDelay={400}>
      <ActionIcon
        variant="subtle"
        size={28}
        className="eva-tabbar-btn"
        data-testid={lead ? 'tab-new' : `tab-new-${group.id}`}
        aria-label="New tab"
        onClick={() => newChatTabIn(group.id)}
      >
        <IconPlus size={16} stroke={1.5} />
      </ActionIcon>
    </Tooltip>
  )
}

/** What a pane's + menu adds (moved here when open elsewhere). */
const ADDABLE: Array<{ label: string; Icon: typeof IconGlobe; add: ToolTab | Place }> = [
  { label: 'Browser', Icon: IconGlobe, add: { kind: 'browser' } },
  { label: 'Files', Icon: IconFiles, add: { kind: 'files' } },
  { label: 'Test Bench', Icon: IconListCheck, add: placeOf('test-bench') },
  { label: 'Canvas', Icon: IconSchema, add: placeOf('canvas') },
  { label: 'Studio', Icon: IconPhotoSpark, add: placeOf('studio') },
]

/**
 * The end of a tool pane's strip: the + menu (add a tab, split, maximize), restore while
 * maximized, and close. A pane holding app tabs shows restore only, like the tab bar did.
 */
export function RightActions({ group }: IDockviewHeaderActionsProps) {
  const pane = usePane(group.id)
  const zoomed = useTiling((s) => s.zoom === group.id)
  const [menu, setMenu] = useState(false)
  if (!pane) return null
  const id = group.id
  const restore = zoomed ? (
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
  ) : null
  if (pane.app) return <div className="eva-dock-actions">{restore}</div>
  return (
    <div className="eva-dock-actions">
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
          {ADDABLE.map(({ label, Icon, add }) => (
            <EvaMenu.Item
              key={label}
              leftSection={<Icon size={16} stroke={1.5} />}
              onClick={() => ('kind' in add ? openTab(add, id) : openPlaceInPane(add, id))}
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
      {restore}
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
    </div>
  )
}

/** Shown only if a pane is ever left empty: the shell background, nothing to read. */
export function Watermark() {
  return <div className="eva-dock-watermark" aria-hidden />
}
