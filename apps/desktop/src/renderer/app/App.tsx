import { useEffect } from 'react'
import { startHotkeyRouter } from '../hotkeys/router'
import { startQuitBridge } from '../dirty/quit-bridge'
import { initE2e } from '../hotkeys/e2e-hooks'
import { loadLayout, registerLayoutActions } from '../shell/layout-store'
import { startTiling } from '../tiling/tiling-store'
import { startBrowserStore } from '../browser/browser-store'
import { startBrowserScope } from '../browser/browser-scope'
import { startTabs } from '../tabs/tabs-store'
import { startSidebar } from '../sidebar/sidebar-store'
import { startHabits } from '../habits/habit-store'
import { startReload } from '../reload/reload'
import { NewTodoModal } from '../todo/NewTodoModal'
import { startNewTodo } from '../todo/new-todo-store'
import { GateOverlay } from '../habits/GateOverlay'
import { startUsage } from '../usage/usage-store'
import { startAssistants } from '../assistants/assistants-store'
import { startBoards } from '../boards/boards-store'
import { startCanvasLive } from '../canvas/live/live-store'
import { startReactions } from '../chat/reactions/reactions-store'
import { startRooms } from '../rooms/rooms-store'
import { Shell } from '../shell/Shell'
import { RelayPinModal } from '../settings/RelayPinModal'
import { startAgentControl } from '../agent/control'
import { startUpdate } from '../update/update-store'
import { startContext } from '../context/context-store'

export function App() {
  useEffect(() => {
    const stopRouter = startHotkeyRouter()
    const stopQuit = startQuitBridge()
    const stopLayout = registerLayoutActions()
    const stopTiling = startTiling()
    const stopBrowserStore = startBrowserStore()
    const stopBrowserScope = startBrowserScope()
    void initE2e()
    void loadLayout()
    const stopTabs = startTabs()
    const stopSidebar = startSidebar()
    const stopReload = startReload()
    const stopNewTodo = startNewTodo()
    const stopHabits = startHabits()
    const stopUsage = startUsage()
    const stopAssistants = startAssistants()
    const stopBoards = startBoards()
    const stopCanvasLive = startCanvasLive()
    const stopReactions = startReactions()
    const stopRooms = startRooms()
    const stopAgent = startAgentControl()
    const stopUpdate = startUpdate()
    const stopContext = startContext()
    return () => {
      stopRouter()
      stopQuit()
      stopLayout()
      stopTiling()
      stopBrowserScope()
      stopBrowserStore()
      stopTabs()
      stopSidebar()
      stopReload()
      stopNewTodo()
      stopHabits()
      stopUsage()
      stopAssistants()
      stopBoards()
      stopCanvasLive()
      stopReactions()
      stopRooms()
      stopAgent()
      stopUpdate()
      stopContext()
    }
  }, [])
  return (
    <>
      <Shell />
      <NewTodoModal />
      <GateOverlay />
      <RelayPinModal />
    </>
  )
}
