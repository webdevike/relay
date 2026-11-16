import { chatStore } from '../chat/chat-store'
import { fillComposer } from '../chat/composer-fill'
import { frontChatPaneOf } from '../chat/front-chat'
import { invoke } from '../ipc'
import { agentOf, assistantsStore } from './assistants-store'

/** Assistant `agent`'s title from the last list, else its id. */
export function assistantTitle(agent: string): string {
  return agentOf(assistantsStore.getState(), agent)?.title ?? agent
}

/**
 * Posts `text` into assistant `agent`'s thread as Isaac, as if he typed it there: through the chat
 * in front when it shows that thread (the composer's own send), else through Relay as his turn
 * (`assistant.turn`; the host checks `agent` against its registry and refuses an unknown one).
 * Null when it went out, else why not.
 */
export async function sendToAssistant(agent: string, text: string): Promise<string | null> {
  const file = agentOf(assistantsStore.getState(), agent)?.file ?? null
  const paneId = frontChatPaneOf()
  const pane = paneId === '' ? undefined : chatStore.getState().panes[paneId]
  const r =
    file !== null && pane?.file === file
      ? await invoke('chat.send', { paneId, text }).catch(() => null)
      : await invoke('assistants.turn', { agent, text }).catch(() => null)
  return r === null ? 'Relay did not answer.' : r.ok ? null : r.error.message
}

/** Puts `text` in the composer of assistant `agent`'s thread, wherever and whenever it shows,
 * for Isaac to read and send himself. */
export function draftToAssistant(agent: string, text: string): void {
  fillComposer(`assistant:${agent}`, text)
}
