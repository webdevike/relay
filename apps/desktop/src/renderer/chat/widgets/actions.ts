import { createContext, useContext } from 'react'
import type { OpenUIRuntime } from '@evaos/chat-core/openui'

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

/** The live runtime of the ```openui block a button or field sits in: buttons with an `action` id
 * dispatch to it and fields with a `bind` id write to it. Null outside an OpenUI block. */
export const OpenUIActions = createContext<Pick<OpenUIRuntime, 'dispatch' | 'setInput'> | null>(
  null,
)

/** The message a reply's blocks belong to, so an OpenUI block keeps its runtime (and the state the
 * user gave it) across rerenders, streaming and the log unmounting rows scrolled out of view. Null
 * outside a chat message: each block then keeps its own. */
export const WidgetScope = createContext<string | null>(null)
