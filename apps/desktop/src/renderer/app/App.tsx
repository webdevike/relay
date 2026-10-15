import { useEffect } from 'react'
import { startHotkeyRouter } from '../hotkeys/router'
import { startQuitBridge } from '../dirty/quit-bridge'
import { initE2e } from '../hotkeys/e2e-hooks'
import { loadLayout, registerLayoutActions } from '../shell/layout-store'
import { startTabs } from '../tabs/tabs-store'
import { Shell } from '../shell/Shell'

export function App() {
  useEffect(() => {
    const stopRouter = startHotkeyRouter()
    const stopQuit = startQuitBridge()
    const stopLayout = registerLayoutActions()
    void initE2e()
    void loadLayout()
    const stopTabs = startTabs()
    return () => {
      stopRouter()
      stopQuit()
      stopLayout()
      stopTabs()
    }
  }, [])
  return <Shell />
}
