import { on } from '../ipc'
import { registerAction } from '../hotkeys/router'
import { refreshSidebar } from '../sidebar/sidebar-store'

export type EvaArea = 'workspaces' | 'memory' | 'jobs' | 'meetings'

/** The single owner of the reload action: sidebar counts plus every mounted page reloader. */
const reloaders = new Map<string, { fn: () => Promise<void>; areas: readonly EvaArea[] | null }>()

/**
 * `areas` limits which `eva.changed` areas trigger this reloader; omitted means every area and
 * `[]` means none (focus, the reload action and the poll still run it).
 */
export function registerReloader(
  id: string,
  fn: () => Promise<void>,
  areas: readonly EvaArea[] | null = null,
): () => void {
  const entry = { fn, areas }
  reloaders.set(id, entry)
  return () => {
    if (reloaders.get(id) === entry) reloaders.delete(id)
  }
}

/** Page reloaders only (window focus path; the sidebar has its own focus refresh). */
export async function reloadPages(changed?: readonly EvaArea[]): Promise<void> {
  const due = [...reloaders.values()].filter(
    (r) => !changed || r.areas === null || r.areas.some((a) => changed.includes(a)),
  )
  await Promise.all(due.map((r) => r.fn().catch(() => {})))
}

export async function reloadAll(changed?: readonly EvaArea[]): Promise<void> {
  await Promise.all([refreshSidebar(), reloadPages(changed)])
}

let started: (() => void) | null = null

/** Idempotent: registers the one 'reload' action and the window focus listener. */
export function startReload(): () => void {
  if (started) return started
  const onFocus = (): void => {
    void reloadPages()
  }
  window.addEventListener('focus', onFocus)
  const off = registerAction('reload', () => void reloadAll())
  const offChanged = on('eva.changed', (e) => void reloadAll(e.areas))
  const dispose = (): void => {
    window.removeEventListener('focus', onFocus)
    off()
    offChanged()
    started = null
  }
  started = dispose
  return dispose
}

export function resetReloadForTests(): void {
  started?.()
  reloaders.clear()
}
