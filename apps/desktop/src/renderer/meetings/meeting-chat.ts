import { notifications } from '@mantine/notifications'
import { agentOf, assistantsStore } from '../assistants/assistants-store'
import { chatStore } from '../chat/chat-store'
import { frontChatPaneOf } from '../chat/front-chat'
import { invoke } from '../ipc'

/**
 * Posts `text` into assistant `agent`'s thread as Isaac, as if he typed it there: through the chat
 * in front when it shows that thread (the composer's own send), else through Relay as his turn.
 * The host adds the meeting's transcript itself; the text is only the question.
 */
export async function askInChat(agent: string, text: string): Promise<string | null> {
  const file = agentOf(assistantsStore.getState(), agent)?.file ?? null
  const paneId = frontChatPaneOf()
  const pane = paneId === '' ? undefined : chatStore.getState().panes[paneId]
  const r =
    file !== null && pane?.file === file
      ? await invoke('chat.send', { paneId, text }).catch(() => null)
      : await invoke('assistants.turn', { agent, text }).catch(() => null)
  const failed = r === null ? 'Relay did not answer.' : r.ok ? null : r.error.message
  if (failed !== null) notifications.show({ message: failed, color: 'red', autoClose: 6000 })
  return failed
}
