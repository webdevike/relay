import { ChatPane } from '../chat/ChatPane'
import { TabBar } from '../tabs/TabBar'
import { useTabs } from '../tabs/tabs-store'

/** Tab strip on top; 02-10 swaps the chat pane for the page router. */
export function MainCard() {
  const loaded = useTabs((s) => s.loaded)
  if (!loaded) return null
  return (
    <>
      <TabBar />
      <ChatPane />
    </>
  )
}
