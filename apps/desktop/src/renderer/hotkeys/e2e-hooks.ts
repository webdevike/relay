import { invoke } from '../ipc'
import { setAppearance } from '../theme/theme-store'
import { placeOf, type PageKey } from '@evaos/shell-core'
import { navigateTo, tabsStore } from '../tabs/tabs-store'
import { tabTitle } from '../tabs/tab-meta'
import type { Appearance } from '@evaos/theme-core'

export interface HotkeyLogEntry {
  chord: string
  action: string
  at: number
}

export interface EvaosShellHooks {
  openTestOverlay(): void
  markDirty(label: string): string
  clearDirty(id: string): void
  setAppearance(appearance: Appearance): void
  pageFiller: boolean
  tabs(): {
    active: number
    list: Array<{ id: number; page: string; pinned: boolean; title: string }>
  }
  openPlace(page: string, newTab?: boolean): void
  openChat(): void
  setPageFiller(on: boolean): void
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
        setAppearance: (a) => setAppearance(a),
        pageFiller: false,
        tabs: () => {
          const t = tabsStore.getState().tabs
          return {
            active: t.active,
            list: t.list.map((x) => ({
              id: x.id,
              page: x.here.page,
              pinned: x.pinned,
              title: tabTitle(x.here),
            })),
          }
        },
        openPlace: (page, newTab) => navigateTo(placeOf(page as PageKey), { newTab }),
        openChat: () => navigateTo(placeOf('chat')),
        setPageFiller: (on) => {
          if (window.__evaosShell) window.__evaosShell.pageFiller = on
        },
      }
    }
    return e2e
  })
  return memo
}
