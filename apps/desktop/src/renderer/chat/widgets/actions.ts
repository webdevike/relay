import { createContext, useContext } from 'react'
import { notifications } from '@mantine/notifications'
import type { OpenUIQueryClient, OpenUIRuntime } from '@evaos/chat-core/openui'
import { assistantTitle, sendToAssistant } from '../../assistants/assistant-send'

/** What a widget's reply button or field can do: send text as Isaac's next turn to the chat. */
export interface WidgetActionsValue {
  reply(text: string): void
  /** False where the composer could not send either: no session in the pane. */
  canReply: boolean
}

/** Outside a chat pane, replies are off and their controls show disabled. */
export const WidgetActions = createContext<WidgetActionsValue>({
  reply: () => {},
  canReply: false,
})

export function useWidgetActions(): WidgetActionsValue {
  return useContext(WidgetActions)
}

/**
 * Sends a widget's text as Isaac's turn in assistant `agent`'s thread: a button with an assistant
 * id (`@ToAssistant("text", "penny")`, `{reply, agent}`) or a page's `relay.reply(text, {agent})`.
 * Works with or without a session in the pane. Called only from a click. A dashboard tile shows
 * the outcome on itself; elsewhere a quiet notification does.
 */
export const AssistantSend = createContext<(agent: string, text: string) => void>((agent, text) => {
  void sendToAssistant(agent, text).then((failed) =>
    notifications.show(
      failed === null
        ? { message: `Sent to ${assistantTitle(agent)}`, autoClose: 2500 }
        : { message: failed, color: 'red', autoClose: 6000 },
    ),
  )
})

/** The live runtime of the ```openui block a button or field sits in: buttons with an `action` id
 * dispatch to it and fields with a `bind` id write to it. Null outside an OpenUI block. */
export const OpenUIActions = createContext<Pick<OpenUIRuntime, 'dispatch' | 'setInput'> | null>(
  null,
)

/** The message a reply's blocks belong to, so an OpenUI block keeps its runtime (and the state the
 * user gave it) across rerenders, streaming and the log unmounting rows scrolled out of view. Null
 * outside a chat message: each block then keeps its own. */
export const WidgetScope = createContext<string | null>(null)

/** Runs a live ```openui block's Query statements (dashboard tiles, canvas `ui` cards); a block
 * created under it fetches while mounted and refreshes on its own intervals. Null in chat, where a
 * Query shows its defaults. Keep the value stable: a block keeps the client it was created with. */
export const OpenUIQuery = createContext<OpenUIQueryClient | null>(null)
