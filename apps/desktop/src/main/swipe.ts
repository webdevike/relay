import type { BaseWindow } from 'electron'
import type { MainContext } from './context'
import { emit } from './ipc/handle'

/**
 * macOS's trackpad swipe between pages (a three-finger swipe, or two when System Settings > Trackpad
 * > More Gestures > Swipe between pages is set that way) as the window's Back and Forward. Electron
 * names the direction the old-style swipe went: left is Back, right is Forward. Up and down do
 * nothing. The renderer's router runs the same actions as ⌘[ and ⌘].
 */
export function swipeChord(direction: string): string | null {
  if (direction === 'left') return 'cmd+['
  if (direction === 'right') return 'cmd+]'
  return null
}

/** Wires the window's swipe event to the renderer's history actions; returns the unwire. */
export function wireSwipeHistory(ctx: MainContext, win: BaseWindow): () => void {
  const onSwipe = (_event: unknown, direction: string): void => {
    const chord = swipeChord(direction)
    if (chord) emit(ctx, 'app.hotkey', { chord, fromGuest: false })
  }
  win.on('swipe', onSwipe)
  return () => win.off('swipe', onSwipe)
}
