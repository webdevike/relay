import { isOpenTodoRow, openSectionLines } from '../model/todos'

/** Count open todo rows under `## Open` (port of eva.rs parse_open_todos, shared row rule). */
export function countOpenTodos(text: string): number {
  return openSectionLines(text).filter(isOpenTodoRow).length
}
