import type { AgentFocus } from '@evaos/contract'

/**
 * Agent actions must never take the keyboard from Isaac. Two rules:
 * - While he is typing in a text field an action would replace, the action waits in a queue
 *   (`decide`): `main` actions (page, chat, tab) replace the chat pane and what follows it,
 *   `panel` actions only the tool panes, so opening a file while he types in the composer runs
 *   at once.
 * - Every action runs with a focus hold: components that focus something on their own (the
 *   Files editor) skip it while `focusHeld()`, and a field that lost focus anyway gets it back.
 */

/** Elements that take typed text: the composer, inputs, Monaco, contenteditable. */
export function isEditable(el: Element | null): boolean {
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled
  if (el instanceof HTMLInputElement) {
    const nonText = ['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file']
    return !el.readOnly && !el.disabled && !nonText.includes(el.type)
  }
  return el instanceof HTMLElement && el.isContentEditable === true
}

export interface FocusSnapshot {
  /** document.hasFocus(): the window is the key window and the shell page holds focus. */
  windowFocused: boolean
  /** The focused element takes text. */
  editable: boolean
  /** The focused element sits in a tool pane. */
  inPanel: boolean
}

export function snapshotFocus(doc: Document = document): FocusSnapshot {
  const el = doc.activeElement
  return {
    windowFocused: doc.hasFocus(),
    editable: isEditable(el),
    inPanel: el?.closest('[data-pane-kind=tool]') != null,
  }
}

export function isTyping(s: FocusSnapshot): boolean {
  return s.windowFocused && s.editable
}

/** Run now, or queue until Isaac stops typing where the action lands. */
export function decide(focus: AgentFocus, s: FocusSnapshot): 'run' | 'queue' {
  if (!isTyping(s) || focus === 'none') return 'run'
  return focus === 'main' || s.inPanel ? 'queue' : 'run'
}

/**
 * The element to give focus back to after an action: the text field Isaac had, if the action
 * moved focus off it and it is still on the page.
 */
export function restoreTarget(before: Element | null, after: Element | null): HTMLElement | null {
  if (before === after || !isEditable(before) || !(before instanceof HTMLElement)) return null
  return before.isConnected ? before : null
}

let holds = 0

/** True while an agent action runs (and shortly after): skip programmatic focus. */
export function focusHeld(): boolean {
  return holds > 0
}

/**
 * Runs `fn` under a focus hold. The hold lasts `tailMs` past the action, so effects that focus
 * after the next render still see it; then a text field that lost focus gets it back.
 */
export async function withFocusHold<T>(fn: () => Promise<T> | T, tailMs = 1000): Promise<T> {
  holds++
  const before = document.activeElement
  try {
    return await fn()
  } finally {
    setTimeout(() => {
      holds--
      restoreTarget(before, document.activeElement)?.focus({ preventScroll: true })
    }, tailMs)
  }
}
