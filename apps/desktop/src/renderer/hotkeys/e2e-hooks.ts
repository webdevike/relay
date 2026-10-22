import { invoke } from '../ipc'
import { setColorScheme, type ColorScheme } from '../theme/theme-config'
import { pageFromKey, placeOf, type Place } from '@evaos/shell-core'
import { navigateTo, tabsStore } from '../tabs/tabs-store'
import { tabTitle } from '../tabs/tab-meta'

export interface HotkeyLogEntry {
  chord: string
  action: string
  at: number
}

export interface EvaosShellHooks {
  openTestOverlay(): void
  markDirty(label: string): string
  clearDirty(id: string): void
  dirtySaves(): number
  setAppearance(appearance: ColorScheme): void
  tabs(): {
    active: number
    list: Array<{
      id: number
      page: string
      chat: string | null
      pinned: boolean
      title: string
    }>
  }
  openPlace(page: string, newTab?: boolean, extra?: Partial<Omit<Place, 'page'>>): void
  openChat(): void
}

declare global {
  interface Window {
    __evaosHotkeys?: HotkeyLogEntry[]
    __evaosShell?: EvaosShellHooks
  }
}

let overlayOpener: (() => void) | null = null
type DirtyHooks = { mark(label: string): string; clear(id: string): void; saves(): number }
let dirtyHooks: DirtyHooks | null = null

/** TestOverlay fills this so window.__evaosShell.openTestOverlay works under e2e. */
export function setTestOverlayOpener(fn: (() => void) | null): void {
  overlayOpener = fn
}

/** The dirty store fills these for markDirty and clearDirty. */
export function setDirtyHooks(h: DirtyHooks | null): void {
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
        dirtySaves: () => dirtyHooks?.saves() ?? 0,
        setAppearance: (a) => setColorScheme(a),
        tabs: () => {
          const t = tabsStore.getState().tabs
          return {
            active: t.active,
            list: t.list.map((x) => ({
              id: x.id,
              page: x.here.page,
              chat: x.here.chat,
              pinned: x.pinned,
              title: tabTitle(x.here),
            })),
          }
        },
        openPlace: (key, newTab, extra) => {
          const page = pageFromKey(key)
          if (page) navigateTo(placeOf(page, extra), { newTab })
        },
        openChat: () => navigateTo(placeOf('chat')),
      }
    }
    return e2e
  })
  return memo
}
