import { BrowserPanel } from '../browser/BrowserPanel'
import { setPanelFocused } from '../hotkeys/panel-focus'
import { Grip } from './Grip'
import { useLayout } from './layout-store'

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
        <BrowserPanel />
      </section>
    </div>
  )
}
