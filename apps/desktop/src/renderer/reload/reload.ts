import { on } from '../ipc'
import { registerAction } from '../hotkeys/router'
import { refreshSidebar } from '../sidebar/sidebar-store'

/** The single owner of the reload action: sidebar counts plus every mounted page reloader. */
const reloaders = new Map<string, () => Promise<void>>()

export function registerReloader(id: string, fn: () => Promise<void>): () => void {
  reloaders.set(id, fn)
  return () => {
    if (reloaders.get(id) === fn) reloaders.delete(id)
  }
}

/** Page reloaders only (window focus path; the sidebar has its own focus refresh). */
export async function reloadPages(): Promise<void> {
  await Promise.all([...reloaders.values()].map((fn) => fn().catch(() => {})))
}

export async function reloadAll(): Promise<void> {
  await Promise.all([refreshSidebar(), reloadPages()])
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
  const offChanged = on('eva.changed', () => void reloadAll())
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
