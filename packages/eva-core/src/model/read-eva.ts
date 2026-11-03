import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildDashboard,
  buildWorkspaceDetail,
  type DashboardPayload,
  type WorkspaceDetailPayload,
} from './dashboard'
import { parseJournal, sortJournal, type JournalEntry } from './journal'
import { parseOpenTodos } from './todos'
import type { WorkspaceFile } from './workspaces'

// Read-only: every call here is a read; writes go through EvaFs.

function readText(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  } catch {
    return ''
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Port of eva.rs workspace_files: `workspaces/<id>.md` and `workspaces/<id>/<id>.md`. */
export function workspaceFiles(root: string): WorkspaceFile[] {
  let names: string[]
  try {
    names = readdirSync(join(root, 'workspaces')).sort()
  } catch {
    return []
  }
  const files: WorkspaceFile[] = []
  for (const name of names) {
    const abs = join(root, 'workspaces', name)
    let id: string
    let rel: string
    if (isDir(abs)) {
      id = name
      rel = `workspaces/${name}/${name}.md`
      if (!isFile(join(root, rel))) continue
    } else if (name.endsWith('.md') && name.length > 3) {
      id = name.slice(0, -3)
      rel = `workspaces/${name}`
    } else {
      continue
    }
    files.push({ id, path: rel, text: readText(join(root, rel)) })
  }
  return files
}

/** memory/journal.md plus memory/archive/*.md, newest first. */
export function readJournal(root: string): JournalEntry[] {
  const entries = parseJournal(readText(join(root, 'memory', 'journal.md')), 'memory/journal.md')
  let archive: string[] = []
  try {
    archive = readdirSync(join(root, 'memory', 'archive'))
      .filter((n) => n.endsWith('.md'))
      .sort()
  } catch {
    // no archive
  }
  for (const n of archive) {
    entries.push(
      ...parseJournal(readText(join(root, 'memory', 'archive', n)), `memory/archive/${n}`),
    )
  }
  return sortJournal(entries)
}

/** `todos` is null when memory/todos.md is missing; done is '' when todos-done.md is missing. */
export function readTodoTexts(root: string): { todos: string | null; done: string } {
  const p = join(root, 'memory', 'todos.md')
  let todos: string | null = null
  try {
    todos = existsSync(p) ? readFileSync(p, 'utf8') : null
  } catch {
    todos = null
  }
  return { todos, done: readText(join(root, 'memory', 'todos-done.md')) }
}

export function readDashboard(root: string, today: string, nowMs: number): DashboardPayload {
  const todos = parseOpenTodos(readTodoTexts(root).todos ?? '')
  return buildDashboard(workspaceFiles(root), readJournal(root), todos, today, nowMs)
}

export function readWorkspaceDetail(
  root: string,
  id: string,
  today: string,
): WorkspaceDetailPayload {
  const todos = parseOpenTodos(readTodoTexts(root).todos ?? '')
  return buildWorkspaceDetail(workspaceFiles(root), readJournal(root), todos, id, today)
}
