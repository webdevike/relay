import { createContext, useContext } from 'react'

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
