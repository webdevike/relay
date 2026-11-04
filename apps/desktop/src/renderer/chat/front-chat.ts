import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { activeTabId, tabsStore, useTabs } from '../tabs/tabs-store'

/**
 * Which chat pane each app tab's chat shows under while it is on screen (its own id each mount,
 * see open-chat newChatPaneId). "The chat in front" is the active app tab's: what the context
 * popover, artifacts, subagent tabs and agent actions mean by the chat Isaac is in.
 */
const paneByTab = createStore<{ panes: Record<number, string> }>(() => ({ panes: {} }))

export function setTabChatPane(tab: number, paneId: string | null): void {
  paneByTab.setState((s) => {
    const panes = { ...s.panes }
    if (paneId === null) delete panes[tab]
    else panes[tab] = paneId
    return { panes }
  })
}

/** The chat pane of the active app tab, or '' when it shows no chat. */
export function frontChatPaneOf(): string {
  return paneByTab.getState().panes[activeTabId(tabsStore.getState())] ?? ''
}

export function useFrontChatPane(): string {
  const tab = useTabs(activeTabId)
  return useStore(paneByTab, (s) => s.panes[tab] ?? '')
}

/** Test seam. */
export function resetFrontChatForTests(): void {
  paneByTab.setState({ panes: {} }, true)
}
