import { Notification } from 'electron'
import type { MainContext } from './context'
import { emit } from './ipc/handle'

// Held until closed or answered: a collected Notification loses its handlers on macOS.
const shown = new Set<Notification>()

/**
 * A desktop notification with buttons; `onAnswer` gets the tapped button's index, or -1 for a
 * click on the notification itself. Fixture runs (dev, e2e) never show one.
 */
export function showNotice(
  ctx: MainContext,
  notice: { title: string; body: string; actions: string[] },
  onAnswer: (action: number) => void,
): void {
  if (!ctx.env.live || !Notification.isSupported()) return
  const n = new Notification({
    title: notice.title,
    body: notice.body,
    actions: notice.actions.map((text) => ({ type: 'button' as const, text })),
  })
  shown.add(n)
  n.on('action', (_e, index) => {
    shown.delete(n)
    onAnswer(index)
  })
  n.on('click', () => {
    shown.delete(n)
    onAnswer(-1)
  })
  n.on('close', () => shown.delete(n))
  n.show()
}

/** Brings the window up on a `relay://` link, as a click on a deep link would. */
export function openAppLink(ctx: MainContext, url: string): void {
  if (ctx.win.isMinimized()) ctx.win.restore()
  ctx.win.show()
  ctx.win.focus()
  emit(ctx, 'app.openLink', { url })
}
