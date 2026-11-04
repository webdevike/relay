import type { NotificationPrefs } from '@evaos/contract'

/**
 * When this Mac shows a desktop notification. The phone gets the same events through Relay's push,
 * so the Mac speaks only while Isaac is at it: he touched the keyboard or trackpad in the last
 * ten minutes. Away from the Mac, the phone is the one that buzzes.
 */
export const ACTIVE_WITHIN_S = 600

/** What a notification is about; each kind has its own wording in `events.ts`. */
export type NotifyKind = 'reply' | 'waiting' | 'finished' | 'canvas' | 'update'

/** Where clicking a notification goes: a relay:// link, or a chat's session file. */
export type ClickTarget = { link: string } | { chat: string }

export interface NotifyEvent {
  /** Two events with the same key are one thing told twice (a chat that waits on Isaac). */
  key: string
  kind: NotifyKind
  /** The assistant it comes from (id): muting it silences the event, and its events group. */
  assistant: string | null
  /** The thread it belongs to, as `notifications.visible` names them; null when it has none. */
  thread: string | null
  title: string
  body: string
  /** No sound: the work is done, nothing is waiting. */
  silent: boolean
  click: ClickTarget
}

export interface NotifyState {
  prefs: NotificationPrefs
  /** The window has the keyboard focus. */
  windowFocused: boolean
  /** The threads the window shows now (`assistant:<id>`, `chat:<file>`). */
  visible: ReadonlySet<string>
  /** powerMonitor.getSystemIdleTime(): seconds since the last input on this Mac. */
  idleSeconds: number
}

export type NotifyDecision = { show: true } | { show: false; reason: SkipReason }
export type SkipReason = 'off' | 'muted' | 'away' | 'visible'

/**
 * Whether `event` is shown. Never decided here: what counts as an event (a hidden
 * "(nothing to report)" reply is none, see `events.ts`) and the repeat guard (the notifier's).
 *
 * - The global switch and the assistant's mute come first.
 * - Away from the Mac (ten minutes idle) the phone has it, except for an update: only this app
 *   knows about that.
 * - A focused window already shows what changed: skipped when the event's thread is in front, and
 *   for events with no thread (a canvas with no chat, an update toast) whenever it is focused.
 *   A focused window with some other chat in front still notifies.
 */
export function decide(event: NotifyEvent, state: NotifyState): NotifyDecision {
  if (!state.prefs.enabled) return { show: false, reason: 'off' }
  if (event.assistant !== null && state.prefs.muted.includes(event.assistant)) {
    return { show: false, reason: 'muted' }
  }
  if (event.kind !== 'update' && state.idleSeconds >= ACTIVE_WITHIN_S) {
    return { show: false, reason: 'away' }
  }
  if (state.windowFocused) {
    if (event.thread === null || state.visible.has(event.thread)) {
      return { show: false, reason: 'visible' }
    }
  }
  return { show: true }
}
