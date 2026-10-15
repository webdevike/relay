import { ActionIcon, Tooltip } from '@mantine/core'
import { IconGlobe, IconLayoutSidebarRight } from '@tabler/icons-react'
import { BrowserPanel } from '../browser/BrowserPanel'
import { setPanelFocused } from '../hotkeys/panel-focus'
import { Grip } from './Grip'
import { togglePanel, useLayout } from './layout-store'

/** The panel stays mounted when closed; display none sizes the browser slot to 0 so the native view hides. */
export function PanelCard() {
  const open = useLayout((s) => s.panelPx > 0)
  return (
    <div className="eva-panel-wrap" data-open={open ? 'true' : 'false'}>
      {open ? <Grip edge="panel" /> : null}
      <section
        className="eva-card eva-panel-card"
        data-testid="panel-card"
        onFocusCapture={() => setPanelFocused(true)}
        onBlurCapture={() => setPanelFocused(false)}
      >
        <header className="eva-panel-header" data-testid="panel-header">
          <span className="eva-panel-tool eva-label"><IconGlobe size={16} stroke={1.5} />Browser</span>
          <Tooltip label="Close panel (⌘⇧B)" position="bottom-end" openDelay={400}>
            <ActionIcon variant="subtle" className="eva-header-btn" aria-label="Close panel" data-testid="panel-close" onClick={() => togglePanel()}>
              <IconLayoutSidebarRight size={16} stroke={1.5} />
            </ActionIcon>
          </Tooltip>
        </header>
        <BrowserPanel />
      </section>
    </div>
  )
}
