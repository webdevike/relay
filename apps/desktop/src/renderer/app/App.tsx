import { Rail } from './Rail'
import { ChatPane } from '../chat/ChatPane'
import { BrowserPanel } from '../browser/BrowserPanel'

export function App() {
  return (
    <div className="eva-app">
      <Rail />
      <ChatPane />
      <BrowserPanel />
    </div>
  )
}
