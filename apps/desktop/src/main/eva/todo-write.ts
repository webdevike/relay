import * as fs from 'node:fs'
import * as path from 'node:path'
import { appendTodo } from '@evaos/eva-core/model/todos'
import { workspaceFiles } from '@evaos/eva-core/model/read-eva'
import type { EvaFs } from '@evaos/eva-core'

/** Workspace ids from the checkout plus the built-in 'eva'. */
export function knownTags(root: string): Set<string> {
  const tags = new Set<string>(['eva'])
  for (const f of workspaceFiles(root)) tags.add(f.id)
  return tags
}

function readDone(root: string): string {
  try {
    return fs.readFileSync(path.join(root, 'memory', 'todos-done.md'), 'utf8')
  } catch {
    return ''
  }
}

/**
 * Appends one open row after the last open row of memory/todos.md through EvaFs.edit.
 * todos-done.md is re-read inside the transform so a retry computes a fresh id.
 */
export async function appendTodoVia(
  evaFs: EvaFs,
  root: string,
  tag: string,
  text: string,
  today: string,
): Promise<{ id: string; tag: string; row: string }> {
  let captured: { id: string; row: string } | null = null
  await evaFs.edit(
    'todo-append',
    'memory/todos.md',
    (current) => {
      const r = appendTodo(current, readDone(root), tag, text, today)
      captured = { id: r.id, row: r.row }
      return r.next
    },
    { retryOnChange: true },
  )
  const c = captured as { id: string; row: string } | null
  if (!c) throw Object.assign(new Error('Nothing was appended.'), { code: 'internal' })
  return { id: c.id, tag, row: c.row }
}
