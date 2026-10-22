import { useEffect, useRef, useState } from 'react'
import { ActionIcon, Tooltip } from '@mantine/core'
import { IconGlobe, IconLayoutSidebarRight } from '@tabler/icons-react'
import { BrowserPanel } from '../browser/BrowserPanel'
import { setPanelFocused } from '../hotkeys/panel-focus'
import { Grip } from './Grip'
import { togglePanel, useLayout } from './layout-store'

/** The current panel slide duration in ms; 0 when motion is off. */
function slideMs(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--eva-dur-slide').trim()
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return 0
  return raw.endsWith('ms') ? n : n * 1000
}

/**
 * The panel stays mounted when closed; display none sizes the browser slot to 0 so the native
 * view hides. A close keeps it shown for one slide so the width can animate to 0. The card keeps
 * its width while the wrap narrows, so the page slides out past the window edge unclipped.
 */
export function PanelCard() {
  const open = useLayout((s) => s.panelPx > 0)
  const [shown, setShown] = useState(open)
  const previous = useRef(open)

  useEffect(() => {
    if (previous.current === open) return
    previous.current = open
    if (open) {
      setShown(true)
      return
    }
    const ms = slideMs()
    if (!ms) {
      setShown(false)
      return
    }
    const timer = window.setTimeout(() => setShown(false), ms)
    return () => window.clearTimeout(timer)
  }, [open])

  return (
    <div
      className="eva-panel-wrap"
      data-open={shown ? 'true' : 'false'}
      data-closing={shown && !open ? 'true' : undefined}
    >
      {open ? <Grip edge="panel" /> : null}
      <div className="eva-panel-clip">
        <section
          className="eva-card eva-panel-card"
          data-testid="panel-card"
          onFocusCapture={() => setPanelFocused(true)}
          onBlurCapture={() => setPanelFocused(false)}
        >
          <header className="eva-panel-header" data-testid="panel-header">
            <span className="eva-panel-tool">
              <IconGlobe size={16} stroke={1.5} />
              Browser
            </span>
            <Tooltip label="Close panel (⌘⇧B)" position="bottom-end" openDelay={400}>
              <ActionIcon
                variant="subtle"
                className="eva-header-btn"
                aria-label="Close panel"
                data-testid="panel-close"
                onClick={() => togglePanel()}
              >
                <IconLayoutSidebarRight size={16} stroke={1.5} />
              </ActionIcon>
            </Tooltip>
          </header>
          <BrowserPanel />
        </section>
      </div>
    </div>
  )
}
