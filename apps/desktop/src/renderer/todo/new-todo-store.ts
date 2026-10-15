import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { registerAction } from '../hotkeys/router'
import { overlayStore } from '../overlay/overlay-store'

export interface NewTodoState {
  opened: boolean
  tag: string
  lastTag: string | null
}

const initial = (): NewTodoState => ({ opened: false, tag: 'eva', lastTag: null })

export const newTodoStore = createStore<NewTodoState>(initial)

export function useNewTodo<T>(selector: (s: NewTodoState) => T): T {
  return useStore(newTodoStore, selector)
}

/** Opens the modal: explicit tag, else the last used workspace, else Eva. */
export function openNewTodo(opts?: { tag?: string }): void {
  const s = newTodoStore.getState()
  newTodoStore.setState({ opened: true, tag: opts?.tag ?? s.lastTag ?? 'eva' })
}

export function closeNewTodo(): void {
  newTodoStore.setState({ opened: false })
}

/** Remembers the workspace of a successful add and closes. */
export function finishNewTodo(tag: string): void {
  newTodoStore.setState({ opened: false, lastTag: tag })
}

/** Registers the one 'new-todo' action; ignored while any other overlay is open. */
export function startNewTodo(): () => void {
  return registerAction('new-todo', () => {
    if (overlayStore.getState().ids.size > 0) return
    openNewTodo()
  })
}

export function resetNewTodoForTests(): void {
  newTodoStore.setState(initial(), true)
}
