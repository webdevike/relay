import { useEffect } from 'react'
import { startHotkeyRouter } from '../hotkeys/router'
import { startQuitBridge } from '../dirty/quit-bridge'
import { initE2e } from '../hotkeys/e2e-hooks'
import { loadLayout, registerLayoutActions } from '../shell/layout-store'
import { startTabs } from '../tabs/tabs-store'
import { startSidebar } from '../sidebar/sidebar-store'
import { startHabits } from '../habits/habit-store'
import { startReload } from '../reload/reload'
import { NewTodoModal } from '../todo/NewTodoModal'
import { startNewTodo } from '../todo/new-todo-store'
import { GateOverlay } from '../habits/GateOverlay'
import { startUsage } from '../usage/usage-store'
import { startAssistants } from '../assistants/assistants-store'
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
    const stopNewTodo = startNewTodo()
    const stopHabits = startHabits()
    const stopUsage = startUsage()
    const stopAssistants = startAssistants()
    return () => {
      stopRouter()
      stopQuit()
      stopLayout()
      stopTabs()
      stopSidebar()
      stopReload()
      stopNewTodo()
      stopHabits()
      stopUsage()
      stopAssistants()
    }
  }, [])
  return (
    <>
      <Shell />
      <NewTodoModal />
      <GateOverlay />
    </>
  )
}
