import { parseDay } from './dates'
import { plain } from './plain'
import { canonicalTag } from './tags'

export interface OpenTodo {
  id: string
  tag: string
  text: string
  added: string | null
}

interface Row {
  id: string
  rest: string
  open: number
  close: number
}

const ROW_PREFIX = '- [ ] '

/** Shared row rule of eva.rs parse_open_todos: `- [ ] T<n> [tag] text`. */
function parseRow(line: string): Row | null {
  if (!line.startsWith(ROW_PREFIX)) return null
  const afterPrefix = line.slice(ROW_PREFIX.length)
  const sp = afterPrefix.indexOf(' ')
  if (sp < 0) return null
  const id = afterPrefix.slice(0, sp)
  if (!id.startsWith('T')) return null
  const rest = afterPrefix.slice(sp + 1)
  const open = rest.indexOf('[')
  if (open < 0) return null
  const close = rest.indexOf(']', open)
  if (close < 0) return null
  return { id, rest, open, close }
}

/** True for an open todo row the dashboard and the sidebar count agree on. */
export function isOpenTodoRow(line: string): boolean {
  return parseRow(line) !== null
}

/** Lines of the `## Open` section (heading excluded). */
export function openSectionLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim() === '## Open')
  if (start < 0) return []
  const out: string[] = []
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith('## ')) break
    out.push(l)
  }
  return out
}

/** Port of eva.rs parse_open_todos. */
export function parseOpenTodos(text: string): OpenTodo[] {
  const todos: OpenTodo[] = []
  for (const line of openSectionLines(text)) {
    const row = parseRow(line)
    if (!row) continue
    let body = row.rest.slice(row.close + 1).trim()
    let added: string | null = null
    const start = body.lastIndexOf('(added ')
    if (start >= 0) {
      const date = body.slice(start + 7, start + 17)
      if (parseDay(date) !== null) {
        added = date
        body = body.slice(0, start).trimEnd()
      }
    }
    todos.push({
      id: row.id,
      tag: canonicalTag(row.rest.slice(row.open + 1, row.close)),
      text: plain(body),
      added,
    })
  }
  return todos
}

/** Port of eva.rs max_todo_id: every `T<digits>` at a word start, prose included. */
export function maxTodoId(text: string): number {
  let max = 0
  for (const m of text.matchAll(/(?<![\p{L}\p{N}])T(\d+)/gu)) max = Math.max(max, Number(m[1]))
  return max
}

export function nextTodoId(todos: string, done: string): string {
  return `T${Math.max(maxTodoId(todos), maxTodoId(done)) + 1}`
}

/** Pure port of eva.rs append_todo. Throws code 'invalid-data' without a `## Open` heading. */
export function appendTodo(
  todos: string,
  done: string,
  tag: string,
  text: string,
  today: string,
): { id: string; row: string; next: string } {
  const id = nextTodoId(todos, done)
  const clean = text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
  const row = `- [ ] ${id} [${tag}] ${clean} (added ${today})`
  const hadFinalNewline = todos.endsWith('\n')
  const lines = todos.split('\n')
  const body = hadFinalNewline ? lines.slice(0, -1) : lines
  const open = body.findIndex((l) => l.trim() === '## Open')
  if (open < 0) {
    throw Object.assign(new Error('todos.md has no ## Open'), { code: 'invalid-data' })
  }
  let end = body.findIndex((l, i) => i > open && l.startsWith('## '))
  if (end < 0) end = body.length
  let last = -1
  for (let i = open + 1; i < end; i++) if (body[i]!.startsWith('- [ ] T')) last = i
  const at = last < 0 ? open + 2 : last + 1
  const out = [...body.slice(0, at), row, ...body.slice(at)].join('\n')
  return { id, row, next: hadFinalNewline ? `${out}\n` : out }
}
