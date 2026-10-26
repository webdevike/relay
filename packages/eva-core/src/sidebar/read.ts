import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { jobScheduled } from './jobs'
import { countOpenTodos } from './todos'

export interface SidebarData {
  openTodos: number
  scheduledJobs: number
}

function readText(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  } catch {
    return ''
  }
}

export function readSidebar(root: string): SidebarData {
  const openTodos = countOpenTodos(readText(join(root, 'memory', 'todos.md')))
  let scheduledJobs = 0
  try {
    for (const d of readdirSync(join(root, 'jobs'), { withFileTypes: true })) {
      if (d.isDirectory() && jobScheduled(readText(join(root, 'jobs', d.name, 'job.md')))) {
        scheduledJobs++
      }
    }
  } catch {
    // no jobs dir
  }
  return { openTodos, scheduledJobs }
}
