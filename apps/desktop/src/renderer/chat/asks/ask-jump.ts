import type { OpenAsk } from '@evaos/contract'

const jumpers = new Map<string, (ask: OpenAsk) => boolean>()

/** A chat log says how to bring the bubble an open ask sits on into view; true when it did. */
export function registerAskJump(paneId: string, fn: (ask: OpenAsk) => boolean): () => void {
  jumpers.set(paneId, fn)
  return () => {
    if (jumpers.get(paneId) === fn) jumpers.delete(paneId)
  }
}

/** Scrolls the chat in `paneId` to `ask`'s bubble and flashes it; false when the ask has no bubble in the log. */
export function jumpToAsk(paneId: string, ask: OpenAsk): boolean {
  return jumpers.get(paneId)?.(ask) ?? false
}
