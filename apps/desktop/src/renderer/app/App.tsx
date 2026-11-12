import { useEffect } from 'react'
import { startHotkeyRouter } from '../hotkeys/router'
import { startQuitBridge } from '../dirty/quit-bridge'
import { initE2e } from '../hotkeys/e2e-hooks'
import { loadLayout, registerLayoutActions } from '../shell/layout-store'
import { startTiling } from '../tiling/tiling-store'
import { startBrowserStore } from '../browser/browser-store'
import { startBrowserScope } from '../browser/browser-scope'
import { startWorkspaceOwners } from '../chat/workspace-owners'
import { startTabs } from '../tabs/tabs-store'
import { startSidebar } from '../sidebar/sidebar-store'
import { startHabits } from '../habits/habit-store'
import { useProfile } from '../pages/profile'
import { startReload } from '../reload/reload'
import { NewTodoModal } from '../todo/NewTodoModal'
import { startNewTodo } from '../todo/new-todo-store'
import { GateOverlay } from '../habits/GateOverlay'
import { startUsage } from '../usage/usage-store'
import { startAssistants } from '../assistants/assistants-store'
import { startBoards } from '../boards/boards-store'
import { startCanvasLive } from '../canvas/live/live-store'
import { startCanvasRuns } from '../canvas/agent/runs-store'
import { startReactions } from '../chat/reactions/reactions-store'
import { startRooms } from '../rooms/rooms-store'
import { Shell } from '../shell/Shell'
import { RelayPinModal } from '../settings/RelayPinModal'
import { startAgentControl } from '../agent/control'
import { startUpdate } from '../update/update-store'
import { startMemoryWatch } from '../setup/memory-watch'
import { startContext } from '../context/context-store'
import { startDeepLinks } from '../navigation/deep-links'
import { startNotificationBridge } from '../notifications/visible-threads'
import { Spotlight } from '../tour/Spotlight'

export function App() {
  useEffect(() => {
    const stopRouter = startHotkeyRouter()
    const stopQuit = startQuitBridge()
    const stopLayout = registerLayoutActions()
    const stopTiling = startTiling()
    const stopBrowserStore = startBrowserStore()
    const stopBrowserScope = startBrowserScope()
    const stopOwners = startWorkspaceOwners()
    void initE2e()
    void loadLayout()
    const stopTabs = startTabs()
    const stopSidebar = startSidebar()
    const stopReload = startReload()
    const stopNewTodo = startNewTodo()
    const stopUsage = startUsage()
    const stopAssistants = startAssistants()
    const stopBoards = startBoards()
    const stopCanvasLive = startCanvasLive()
    const stopCanvasRuns = startCanvasRuns()
    const stopReactions = startReactions()
    const stopRooms = startRooms()
    const stopAgent = startAgentControl()
    const stopUpdate = startUpdate()
    const stopContext = startContext()
    const stopDeepLinks = startDeepLinks()
    return () => {
      stopRouter()
      stopQuit()
      stopLayout()
      stopTiling()
      stopBrowserScope()
      stopOwners()
      stopBrowserStore()
      stopTabs()
      stopSidebar()
      stopReload()
      stopNewTodo()
      stopUsage()
      stopAssistants()
      stopBoards()
      stopCanvasLive()
      stopCanvasRuns()
      stopReactions()
      stopRooms()
      stopAgent()
      stopUpdate()
      stopContext()
      stopDeepLinks()
    }
  }, [])
  // Main's notifications stay quiet for the chats this window shows; a click opens its chat.
  useEffect(() => startNotificationBridge(), [])
  const profile = useProfile()
  // The habit gate is Isaac's: a starter home never polls it or shows its break screen.
  useEffect(() => (profile === 'eva' ? startHabits() : undefined), [profile])
  // A starter home's memory runs here; tell the user when it stops saving.
  useEffect(() => (profile === 'starter' ? startMemoryWatch() : undefined), [profile])
  return (
    <>
      <Shell />
      <NewTodoModal />
      {profile === 'eva' ? <GateOverlay /> : null}
      <RelayPinModal />
      <Spotlight />
    </>
  )
}
