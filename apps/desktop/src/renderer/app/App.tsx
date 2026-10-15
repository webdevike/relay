import { useEffect, useState } from 'react'
import { Rail } from './Rail'
import { PANEL_MAX, PANEL_MIN, PanelDivider } from './PanelDivider'
import { ChatPane } from '../chat/ChatPane'
import { BrowserPanel } from '../browser/BrowserPanel'
import { startHotkeyRouter } from '../hotkeys/router'
import { startQuitBridge } from '../dirty/quit-bridge'
import { initE2e } from '../hotkeys/e2e-hooks'
import { TestOverlay, useTestOverlayOpener } from '../overlay/TestOverlay'

const RAIL_W = 272
const MAIN_MIN = 480

export function App() {
  const [panelW, setPanelW] = useState(480)
  const [winW, setWinW] = useState(window.innerWidth)
  const [overlayOpen, setOverlayOpen] = useState(false)
  useTestOverlayOpener(() => setOverlayOpen(true))
  useEffect(() => {
    const stopRouter = startHotkeyRouter()
    const stopQuit = startQuitBridge()
    void initE2e()
    return () => {
      stopRouter()
      stopQuit()
    }
  }, [])
  useEffect(() => {
    const on = (): void => setWinW(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])

  const collapsed = winW < RAIL_W + MAIN_MIN + PANEL_MIN
  const railW = collapsed ? 0 : RAIL_W
  const max = Math.min(PANEL_MAX, winW - railW - MAIN_MIN)
  const width = Math.min(Math.max(panelW, PANEL_MIN), Math.max(PANEL_MIN, max))

  return (
    <div
      className={`eva-app${collapsed ? ' is-rail-collapsed' : ''}`}
      style={{ '--eva-panel-w': `${width}px` } as React.CSSProperties}
    >
      <Rail onOpenTestOverlay={() => setOverlayOpen(true)} />
      <ChatPane />
      <PanelDivider width={width} max={max} onChange={setPanelW} />
      <BrowserPanel />
      <TestOverlay opened={overlayOpen} onClose={() => setOverlayOpen(false)} />
    </div>
  )
}
