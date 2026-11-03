import 'dockview-react/dist/styles/dockview.css'
import '../../tabs/tabs.css'
import './dock.css'
import { useEffect, useRef } from 'react'
import { DockviewReact, type DockviewReadyEvent, type DockviewTheme } from 'dockview-react'
import { GAP } from '@evaos/shell-core'
import { useBrowserHotkeys } from '../../browser/useBrowserHotkeys'
import { ChatRuntime } from '../../chat/ChatPane'
import { useFilesHotkeys } from '../../files/files-hotkeys'
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

/** The panes beside the sidebar. */
export function DockRoot() {
  const ref = useRef<HTMLDivElement>(null)
  const detach = useRef<(() => void) | null>(null)
  const zoomed = useTiling((s) => s.zoom !== null)
  useFilesHotkeys()
  useBrowserHotkeys()

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
    detach.current = () => {
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
