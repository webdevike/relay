import type { BaseWindow, Rectangle } from 'electron'
import type { ConfigStore } from './config-store'

export const WINDOW_STATE_FILE = 'window.json'
const SAVE_MS = 500
/** At least this much of the window must stay on a display for the saved spot to count. */
const MIN_VISIBLE = 100

export interface WindowState {
  bounds: Rectangle
  maximized: boolean
  fullScreen: boolean
}

function isRect(v: unknown): v is Rectangle {
  if (typeof v !== 'object' || v === null) return false
  const r: Record<string, unknown> = { ...v }
  return ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(r[k]))
}

/**
 * The saved window, or null when there is none or it no longer fits: a size under the minimum,
 * or a spot on a display that is gone (less than MIN_VISIBLE px of it on any work area).
 */
export function restorableWindow(
  raw: unknown,
  workAreas: readonly Rectangle[],
  min: { width: number; height: number },
): WindowState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { bounds, maximized, fullScreen } = raw as Record<string, unknown>
  if (!isRect(bounds) || bounds.width < min.width || bounds.height < min.height) return null
  const onScreen = workAreas.some((a) => {
    const w = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x)
    const h = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y)
    return w >= MIN_VISIBLE && h >= MIN_VISIBLE
  })
  if (!onScreen) return null
  return {
    bounds: {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    },
    maximized: maximized === true,
    fullScreen: fullScreen === true,
  }
}

/** Saves the window's normal bounds and maximized/full-screen state shortly after each change. */
export function trackWindowState(win: BaseWindow, config: ConfigStore): void {
  let timer: NodeJS.Timeout | null = null
  const save = (): void => {
    clearTimeout(timer ?? undefined)
    timer = null
    if (win.isDestroyed()) return
    const state: WindowState = {
      bounds: win.getNormalBounds(),
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen(),
    }
    try {
      config.writeJson(WINDOW_STATE_FILE, state)
    } catch (e) {
      console.warn('[window] saving bounds failed:', e instanceof Error ? e.message : e)
    }
  }
  const later = (): void => {
    if (!timer) timer = setTimeout(save, SAVE_MS)
  }
  win.on('resize', later)
  win.on('move', later)
  win.on('maximize', later)
  win.on('unmaximize', later)
  win.on('enter-full-screen', later)
  win.on('leave-full-screen', later)
  win.on('close', save)
}
