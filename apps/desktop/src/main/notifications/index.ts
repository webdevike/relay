import { Notification, powerMonitor } from 'electron'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import { registerTestHook } from '../test-hooks'
import { createNotifier, type Notifier, type NotifyPlatform } from './notifier'
import type { ClickTarget } from './policy'

export type { Notifier } from './notifier'

/** What the stand-in platform of e2e runs records instead of showing. */
export interface StubNotification {
  groupId: string
  title: string
  body: string
  silent: boolean
  click(): void
}

function electronPlatform(ctx: MainContext): NotifyPlatform {
  // Held until closed or clicked: a collected Notification loses its click handler on macOS.
  const shown = new Set<Notification>()
  return {
    // Fixture sessions (dev, e2e) never notify, unless a run asks for real ones.
    supported: () =>
      (ctx.env.live || process.env.EVAOS_NOTIFY_REAL === '1') && Notification.isSupported(),
    show({ groupId, title, body, silent, onClick }) {
      const n = new Notification({ title, body, silent, groupId })
      shown.add(n)
      n.on('click', () => {
        shown.delete(n)
        onClick()
      })
      n.on('close', () => shown.delete(n))
      n.show()
    },
    windowFocused: () => !ctx.win.isDestroyed() && ctx.win.isFocused(),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    now: () => Date.now(),
    open: (target) => openTarget(ctx, target),
  }
}

/**
 * Goes where a clicked notification says, bringing the window forward first (Isaac clicked it).
 * A test run goes there without raising the window: no focus is ever taken from Isaac.
 */
function openTarget(ctx: MainContext, target: ClickTarget, raise = true): void {
  if (ctx.win.isDestroyed()) return
  if (raise) {
    if (ctx.win.isMinimized()) ctx.win.restore()
    ctx.win.show()
    ctx.win.focus()
  }
  if ('chat' in target) emit(ctx, 'chat.openRequested', { file: target.chat })
  else emit(ctx, 'app.openLink', { url: target.link })
}

/**
 * E2e runs record notifications instead of showing them (a test never puts a banner over Isaac's
 * work); EVAOS_NOTIFY_REAL=1 shows them for real, which is how the Notification Center check runs.
 * `idle` and `focused` stand in for the Mac's input idle time and the window's focus.
 */
function stubPlatform(ctx: MainContext): {
  platform: NotifyPlatform
  log: StubNotification[]
  state: { idle: number; focused: boolean }
} {
  const log: StubNotification[] = []
  const state = { idle: 0, focused: false }
  return {
    log,
    state,
    platform: {
      supported: () => true,
      show: ({ groupId, title, body, silent, onClick }) =>
        log.push({ groupId, title, body, silent, click: onClick }),
      windowFocused: () => state.focused,
      idleSeconds: () => state.idle,
      now: () => Date.now(),
      open: (target) => openTarget(ctx, target, false),
    },
  }
}

/**
 * Desktop notifications (policy.ts says when, events.ts what, notifier.ts ties them to the app).
 * `notifications.get/set` serve Settings > Notifications, `notifications.visible` is the window
 * telling which chats it shows, `notifications.test` the Send test button.
 */
export function registerNotifications(
  ctx: MainContext,
  assistantOfFile: (file: string) => string | null,
): Notifier {
  const stub = ctx.env.e2e && process.env.EVAOS_NOTIFY_REAL !== '1' ? stubPlatform(ctx) : null
  const notifier = createNotifier({
    config: ctx.config,
    platform: stub?.platform ?? electronPlatform(ctx),
    assistantOfFile,
    onPrefs: (prefs) => emit(ctx, 'notifications.changed', prefs),
  })
  handle(ctx, 'notifications.get', () => notifier.prefs())
  handle(ctx, 'notifications.set', (patch) => notifier.setPrefs(patch))
  handle(ctx, 'notifications.visible', ({ threads }) => {
    notifier.setVisible(threads)
    return {}
  })
  handle(ctx, 'notifications.test', () => ({ shown: notifier.test() }))
  if (stub) registerTestHook('notifications', { notifier, ...stub })
  return notifier
}
