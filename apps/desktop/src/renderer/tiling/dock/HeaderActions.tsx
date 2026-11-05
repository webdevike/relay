import { ActionIcon, Kbd, Tooltip } from '@mantine/core'
import {
  IconArrowLeft,
  IconArrowRight,
  IconArrowsMinimize,
  IconX,
} from '@tabler/icons-react'
import type { IDockviewHeaderActionsProps } from 'dockview-react'
import { appTabOf } from '@evaos/shell-core'
import { useLayout } from '../../shell/layout-store'
import { goBack, goForward, useTabs } from '../../tabs/tabs-store'
import { closePaneById, useTiling, zoomPane, type PaneView } from '../tiling-store'
import { AddMenu } from './AddMenu'

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
  // The tab itself (a stable reference): an object built in the selector would re-render forever.
  const tab = useTabs((s) => (front === null ? undefined : s.tabs.list.find((t) => t.id === front)))
  const history = { back: (tab?.back.length ?? 0) > 0, forward: (tab?.forward.length ?? 0) > 0 }
  const lead = useTiling((s) => s.lead === group.id)
  const topLeft = pane?.rect !== null && pane?.rect?.x === 0 && pane.rect.y === 0
  if (!pane) return null
  const room = sidebar !== 'open' && topLeft
  // Nothing to show: no element, so the strip's gap doesn't push the tabs in (dock.css).
  if (!pane.app && !room) return null
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

/** Right after the last tab of every pane: its one + menu. */
export function LeftActions({ group }: IDockviewHeaderActionsProps) {
  const pane = usePane(group.id)
  const lead = useTiling((s) => s.lead === group.id)
  if (!pane) return null
  return (
    <AddMenu pane={group.id} app={pane.app} testid={lead ? 'tab-new' : `pane-add-${group.id}`} />
  )
}

/**
 * The end of a strip: restore while maximized, and close for a pane holding a tool tab. A pane of
 * app tabs alone shows restore only, like the tab bar did.
 */
export function RightActions({ group }: IDockviewHeaderActionsProps) {
  const pane = usePane(group.id)
  const zoomed = useTiling((s) => s.zoom === group.id)
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
  if (pane.views.every((v) => appTabOf(v) !== null)) {
    return <div className="eva-dock-actions">{restore}</div>
  }
  return (
    <div className="eva-dock-actions">
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
