import type { ActivityItem } from '@evaos/chat-core/activity'
import {
  DEFAULT_NOTIFICATION_PREFS,
  NotificationPrefsSchema,
  type Assistants,
  type CanvasRoom,
  type ChatList,
  type NotificationPrefs,
  type UpdateState,
} from '@evaos/contract'
import type { ChatAlert } from '../chat/chat-alerts'
import type { ConfigStore } from '../config-store'
import {
  chatAlertEvent,
  repliesSince,
  roomsSince,
  updateEvent,
  waitingSince,
  type SeenReplies,
} from './events'
import { decide, type ClickTarget, type NotifyEvent, type SkipReason } from './policy'

export const PREFS_FILE = 'notifications.json'
/** The build "Update ready" last told about; an update is announced once, also across restarts. */
export const STATE_FILE = 'notifications-state.json'
/** The same thing told again inside this window (a chat that asks twice in a row) is skipped. */
export const REPEAT_MS = 60_000

/** What the notifier needs from the machine: Electron's Notification and powerMonitor, or a stand-in. */
export interface NotifyPlatform {
  supported(): boolean
  /** Shows one notification; `onClick` runs when Isaac clicks it. */
  show(n: {
    groupId: string
    title: string
    body: string
    silent: boolean
    onClick: () => void
  }): void
  windowFocused(): boolean
  idleSeconds(): number
  now(): number
  /** Brings the window forward and sends it where the click leads. */
  open(target: ClickTarget): void
}

/** The events the notifier reads; each `on*` takes the whole current state and finds what is new. */
export interface Notifier {
  onAssistants(list: Assistants): void
  onActivity(items: readonly ActivityItem[]): void
  onRooms(rooms: readonly CanvasRoom[] | null): void
  onUpdate(state: UpdateState): void
  /** A chat list with the alerts its tracker found (a chat waits on Isaac, or finished). */
  onChatList(list: ChatList, alerts: readonly ChatAlert[]): void
  prefs(): NotificationPrefs
  setPrefs(patch: Partial<NotificationPrefs>): NotificationPrefs
  setVisible(threads: readonly string[]): void
  /** Shows a test notification past every rule; false where notifications are unsupported. */
  test(): boolean
  /** Why the last events were skipped, newest last (tests and diagnostics). */
  skipped(): readonly { key: string; reason: SkipReason | 'repeat' }[]
}

export function loadPrefs(config: ConfigStore): NotificationPrefs {
  const parsed = NotificationPrefsSchema.safeParse(config.readJson<unknown>(PREFS_FILE, null))
  return parsed.success ? parsed.data : { ...DEFAULT_NOTIFICATION_PREFS, muted: [] }
}

export function createNotifier(deps: {
  config: ConfigStore
  platform: NotifyPlatform
  /** The assistant whose thread a session file is, else null. */
  assistantOfFile: (file: string) => string | null
  /** Called after a prefs change (the Settings page follows). */
  onPrefs: (prefs: NotificationPrefs) => void
}): Notifier {
  const { config, platform } = deps
  let prefs = loadPrefs(config)
  let visible: ReadonlySet<string> = new Set()
  let replies: SeenReplies | null = null
  let waiting: ReadonlySet<string> = new Set()
  let rooms: ReadonlySet<string> | null = null
  const recent = new Map<string, number>()
  const skipped: { key: string; reason: SkipReason | 'repeat' }[] = []

  const show = (e: NotifyEvent): void => {
    if (!platform.supported()) return
    const decision = decide(e, {
      prefs,
      windowFocused: platform.windowFocused(),
      visible,
      idleSeconds: platform.idleSeconds(),
    })
    const skip = (reason: SkipReason | 'repeat'): void => {
      skipped.push({ key: e.key, reason })
      if (skipped.length > 50) skipped.shift()
    }
    if (!decision.show) return skip(decision.reason)
    const now = platform.now()
    const last = recent.get(e.key)
    if (last !== undefined && now - last < REPEAT_MS) return skip('repeat')
    recent.set(e.key, now)
    for (const [k, t] of recent) if (now - t >= REPEAT_MS) recent.delete(k)
    platform.show({
      // One stack per assistant in Notification Center; chats, canvases and updates have their own.
      groupId: e.assistant !== null ? `assistant:${e.assistant}` : e.kind,
      title: e.title,
      body: e.body,
      silent: e.silent,
      onClick: () => platform.open(e.click),
    })
  }

  const readAnnounced = (): string | null => {
    const v = config.readJson<{ updateBuild?: unknown }>(STATE_FILE, {}).updateBuild
    return typeof v === 'string' ? v : null
  }

  return {
    onAssistants(list) {
      const out = repliesSince(replies, list, platform.now())
      replies = out.next
      out.events.forEach(show)
    },
    onActivity(items) {
      const out = waitingSince(waiting, items, platform.now())
      waiting = out.next
      out.events.forEach(show)
    },
    onRooms(list) {
      const out = roomsSince(rooms, list)
      rooms = out.next
      out.events.forEach(show)
    },
    onUpdate(state) {
      const e = updateEvent(state, readAnnounced())
      if (e === null) return
      // Marked before it is shown: a skipped one (the window was focused, so the toast said it) is
      // not told again by a later offer of the same build.
      config.writeJson(STATE_FILE, { updateBuild: state.build })
      show(e)
    },
    onChatList(list, alerts) {
      const rows = new Map(list.rows.map((r) => [r.id, r]))
      for (const a of alerts) {
        const e = chatAlertEvent(a, rows.get(a.id), deps.assistantOfFile)
        if (e !== null) show(e)
      }
    },
    prefs: () => prefs,
    setPrefs(patch) {
      const next = NotificationPrefsSchema.parse({ ...prefs, ...patch })
      prefs = { enabled: next.enabled, muted: [...new Set(next.muted)] }
      config.writeJson(PREFS_FILE, prefs)
      deps.onPrefs(prefs)
      return prefs
    },
    setVisible(threads) {
      visible = new Set(threads)
    },
    test() {
      if (!platform.supported()) return false
      platform.show({
        groupId: 'test',
        title: 'Relay notifications are on',
        body: 'You will see replies, questions and canvases here while you are at this Mac.',
        silent: false,
        onClick: () => platform.open({ link: 'relay://open/settings/notifications' }),
      })
      return true
    },
    skipped: () => skipped,
  }
}
