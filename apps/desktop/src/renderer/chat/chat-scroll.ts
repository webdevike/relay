/**
 * Where each chat's log was scrolled, by session file, so a chat comes back where Isaac left it:
 * after another page hid the chat pane (Canvas and Back to chat), or when a return point asks
 * for an exact offset. In memory only. `pinned` means it followed the end; the offset then does
 * not matter, the end does.
 */
export interface ChatScroll {
  offset: number
  pinned: boolean
}

const MAX_FILES = 200

const memory = new Map<string, ChatScroll>()
/** One-shot restores asked for a file's next showing (Back to chat). */
const pending = new Map<string, ChatScroll>()

/** Records where `file`'s log is now; the newest files are kept. */
export function rememberChatScroll(file: string, scroll: ChatScroll): void {
  if (file === '') return
  memory.delete(file)
  memory.set(file, scroll)
  for (const old of memory.keys()) {
    if (memory.size <= MAX_FILES) break
    memory.delete(old)
  }
}

/** Where `file`'s log was last seen, if it was. */
export function chatScrollOf(file: string): ChatScroll | null {
  return memory.get(file) ?? null
}

/** Puts `file`'s log at `scroll` the next time it shows (wins over the remembered place). */
export function requestChatScroll(file: string, scroll: ChatScroll): void {
  if (file !== '') pending.set(file, scroll)
}

/** The restore asked for `file`, once. */
export function takeChatScrollRequest(file: string): ChatScroll | null {
  const s = pending.get(file) ?? null
  pending.delete(file)
  return s
}

export function resetChatScrollForTests(): void {
  memory.clear()
  pending.clear()
}
