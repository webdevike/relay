import { invoke } from '../ipc'

export interface HotkeyLogEntry {
  chord: string
  action: string
  at: number
}

export interface EvaosShellHooks {
  openTestOverlay(): void
  markDirty(label: string): string
  clearDirty(id: string): void
  pageFiller: boolean
}

declare global {
  interface Window {
    __evaosHotkeys?: HotkeyLogEntry[]
    __evaosShell?: EvaosShellHooks
  }
}

let overlayOpener: (() => void) | null = null
let dirtyHooks: { mark(label: string): string; clear(id: string): void } | null = null

/** TestOverlay fills this so window.__evaosShell.openTestOverlay works under e2e. */
export function setTestOverlayOpener(fn: (() => void) | null): void {
  overlayOpener = fn
}

/** The dirty store fills these for markDirty and clearDirty. */
export function setDirtyHooks(
  h: { mark(label: string): string; clear(id: string): void } | null,
): void {
  dirtyHooks = h
}

let memo: Promise<boolean> | null = null

/** Exposes test hooks only when main reports EVAOS_E2E=1. */
export function initE2e(): Promise<boolean> {
  memo ??= invoke('app.info', {}).then((r) => {
    const e2e = r.ok && r.value.e2e
    if (e2e) {
      window.__evaosHotkeys ??= []
      window.__evaosShell = {
        openTestOverlay: () => overlayOpener?.(),
        markDirty: (label) => dirtyHooks?.mark(label) ?? '',
        clearDirty: (id) => dirtyHooks?.clear(id),
        pageFiller: false,
      }
    }
    return e2e
  })
  return memo
}
