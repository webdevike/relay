import { useEffect } from 'react'
import { startHotkeyRouter } from '../hotkeys/router'
import { startQuitBridge } from '../dirty/quit-bridge'
import { initE2e } from '../hotkeys/e2e-hooks'
import { loadLayout, registerLayoutActions } from '../shell/layout-store'
import { startTabs } from '../tabs/tabs-store'
import { startSidebar } from '../sidebar/sidebar-store'
import { startReload } from '../reload/reload'
import { Shell } from '../shell/Shell'

export function App() {
  useEffect(() => {
    const stopRouter = startHotkeyRouter()
    const stopQuit = startQuitBridge()
    const stopLayout = registerLayoutActions()
    void initE2e()
    void loadLayout()
    const stopTabs = startTabs()
    const stopSidebar = startSidebar()
    const stopReload = startReload()
    return () => {
      stopRouter()
      stopQuit()
      stopLayout()
      stopTabs()
      stopSidebar()
      stopReload()
    }
  }, [])
  return <Shell />
}
