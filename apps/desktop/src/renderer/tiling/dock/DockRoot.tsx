import 'dockview-react/dist/styles/dockview.css'
import '../../tabs/tabs.css'
import './dock.css'
import { useEffect, useRef } from 'react'
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type DockviewTheme,
} from 'dockview-react'
import { GAP } from '@evaos/shell-core'
import { useBrowserHotkeys } from '../../browser/useBrowserHotkeys'
import { ChatRuntime } from '../../chat/ChatPane'
import { useFilesHotkeys } from '../../files/files-hotkeys'
import { useTerminalHotkeys } from '../../terminal/terminal-hotkeys'
import { setFocusedPane } from '../../hotkeys/pane-focus'
import { addOverlay, removeOverlay } from '../../overlay/overlay-store'
import { TabContentHost } from '../tab-content'
import { attachDock, nextGroupId, useTiling } from '../tiling-store'
import { AppPanel, AppTab } from './AppPanel'
import { LeftActions, PrefixActions, RightActions, Watermark } from './HeaderActions'
import { ToolPanel, ToolTabView } from './ToolPanel'

/**
 * dockview as the panes' engine, wearing Relay: Relay's own tabs, header actions and drop
 * overlay, every dockview color from Relay's tokens (dock.css), groups a shell gap apart with the
 * sashes in the gaps like the old dividers.
 */
const RELAY_THEME: DockviewTheme = {
  name: 'relay',
  className: 'dockview-theme-relay',
  gap: GAP,
  dndOverlayMounting: 'absolute',
  dndPanelOverlay: 'group',
  dndTabIndicator: 'line',
  dndOverlayBorder: '1px solid var(--eva-c-ring)',
}

const COMPONENTS = { app: AppPanel, tool: ToolPanel }
const TAB_COMPONENTS = { app: AppTab, tool: ToolTabView }
const DRAG_OVERLAY = 'tab-drag'
const SASH_OVERLAY = 'sash-drag'

/**
 * The sash's two neighbors in its split, as dockview lays them out: the views (a pane, or a split
 * of them) nearest each side of its middle (the sash straddles the gap, not exactly in it).
 */
function sashNeighbors(sash: HTMLElement): [HTMLElement, HTMLElement, boolean] | null {
  const split = sash.closest<HTMLElement>('.dv-split-view-container')
  const views = split?.querySelector(':scope > .dv-view-container')
  if (!split || !views) return null
  const row = split.classList.contains('dv-horizontal')
  const s = sash.getBoundingClientRect()
  const mid = row ? s.left + s.width / 2 : s.top + s.height / 2
  let before: HTMLElement | null = null
  let after: HTMLElement | null = null
  for (const v of views.children) {
    if (!(v instanceof HTMLElement) || v.offsetParent === null) continue
    const r = v.getBoundingClientRect()
    if ((row ? r.right : r.bottom) <= mid) before = v
    else if (!after && (row ? r.left : r.top) >= mid) after = v
  }
  return before && after ? [before, after, row] : null
}

/** Double-click on a sash shares its two neighbors' room evenly, as the old dividers did. */
function evenSash(dock: DockviewApi, sash: HTMLElement): void {
  const hit = sashNeighbors(sash)
  if (!hit) return
  const [a, b, row] = hit
  const pane = a.querySelector<HTMLElement>('.dv-groupview[data-pane-id]')?.dataset['paneId']
  const group = pane ? dock.getGroup(pane) : undefined
  if (!group) return
  const length = (el: HTMLElement): number => {
    const r = el.getBoundingClientRect()
    return row ? r.width : r.height
  }
  const want = Math.round((length(a) + length(b)) / 2)
  const set = (px: number): void => group.api.setSize(row ? { width: px } : { height: px })
  // dockview counts part of the gap into the size it is given: set, measure, set once more.
  set(want)
  const off = want - length(a)
  if (Math.abs(off) >= 1) set(want + off)
}

/** The panes beside the sidebar. */
export function DockRoot() {
  const ref = useRef<HTMLDivElement>(null)
  const detach = useRef<(() => void) | null>(null)
  const zoomed = useTiling((s) => s.zoom !== null)
  useFilesHotkeys()
  useBrowserHotkeys()
  useTerminalHotkeys()

  useEffect(() => () => detach.current?.(), [])

  // The pane holding the keyboard focus, for shortcuts that act where Isaac types.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const paneAt = (t: EventTarget | null): string | null =>
      t instanceof Element
        ? (t.closest<HTMLElement>('.dv-groupview[data-pane-id]')?.dataset['paneId'] ?? null)
        : null
    const onIn = (e: FocusEvent): void => setFocusedPane(paneAt(e.target))
    const onOut = (e: FocusEvent): void => {
      if (!el.contains(e.relatedTarget as Node | null)) setFocusedPane(null)
    }
    el.addEventListener('focusin', onIn)
    el.addEventListener('focusout', onOut)
    return () => {
      el.removeEventListener('focusin', onIn)
      el.removeEventListener('focusout', onOut)
    }
  }, [])

  const onReady = (e: DockviewReadyEvent): void => {
    const el = ref.current
    if (!el) return
    detach.current?.()
    // dockview's live regions (a status and an alert) stay empty with announcements off; left
    // in, they shadow Relay's own status and alert regions for screen readers and getByRole.
    el.querySelectorAll('.dv-live-region, .dv-live-region-assertive').forEach((r) => r.remove())
    const off = attachDock(e.api, el)
    // The browser's native view hides while a tab drags, so the drop overlay over it shows.
    const drag = e.api.onWillDragPanel(() => {
      addOverlay(DRAG_OVERLAY)
      document.body.classList.add('eva-tab-dragging')
      const end = (): void => {
        removeOverlay(DRAG_OVERLAY)
        document.body.classList.remove('eva-tab-dragging')
        window.removeEventListener('pointerup', end, true)
        window.removeEventListener('pointercancel', end, true)
        window.removeEventListener('dragend', end, true)
        window.removeEventListener('drop', end, true)
      }
      window.addEventListener('pointerup', end, true)
      window.addEventListener('pointercancel', end, true)
      window.addEventListener('dragend', end, true)
      window.addEventListener('drop', end, true)
    })
    // A sash drag hides the browser's native view too (it would cover the panes as they move);
    // a double-click shares the two sides evenly.
    const sashAt = (t: EventTarget | null): HTMLElement | null =>
      t instanceof Element ? t.closest<HTMLElement>('.dv-sash') : null
    const onSashDown = (ev: PointerEvent): void => {
      const sash = sashAt(ev.target)
      if (!sash || ev.button !== 0) return
      const row = sash.closest('.dv-split-view-container')?.classList.contains('dv-horizontal')
      addOverlay(SASH_OVERLAY)
      document.body.classList.add(row ? 'eva-resizing' : 'eva-resizing-rows')
      const end = (): void => {
        removeOverlay(SASH_OVERLAY)
        document.body.classList.remove('eva-resizing', 'eva-resizing-rows')
        window.removeEventListener('pointerup', end, true)
        window.removeEventListener('pointercancel', end, true)
        window.removeEventListener('blur', end)
      }
      window.addEventListener('pointerup', end, true)
      window.addEventListener('pointercancel', end, true)
      window.addEventListener('blur', end)
    }
    const onSashDouble = (ev: MouseEvent): void => {
      const sash = sashAt(ev.target)
      if (sash) evenSash(e.api, sash)
    }
    el.addEventListener('pointerdown', onSashDown, true)
    el.addEventListener('dblclick', onSashDouble)
    detach.current = () => {
      el.removeEventListener('pointerdown', onSashDown, true)
      el.removeEventListener('dblclick', onSashDouble)
      drag.dispose()
      off()
    }
  }

  return (
    <div className="eva-tiling" ref={ref} data-testid="tiling" data-zoomed={zoomed || undefined}>
      <DockviewReact
        className="eva-dock"
        theme={RELAY_THEME}
        components={COMPONENTS}
        tabComponents={TAB_COMPONENTS}
        defaultTabComponent={ToolTabView}
        watermarkComponent={Watermark}
        prefixHeaderActionsComponent={PrefixActions}
        leftHeaderActionsComponent={LeftActions}
        rightHeaderActionsComponent={RightActions}
        onReady={onReady}
        dndStrategy="pointer"
        disableFloatingGroups
        groupIdGenerator={nextGroupId}
        scrollbars="native"
        announcements={false}
      />
      <ChatRuntime />
      <TabContentHost />
    </div>
  )
}
