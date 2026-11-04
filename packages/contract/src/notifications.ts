import { z } from 'zod'

/**
 * Settings > Notifications: the global switch and the assistants muted one by one. Saved in the
 * config folder (`notifications.json`), per Mac: the MacBook and the Mini each have their own.
 */
export const NotificationPrefsSchema = z.object({
  /** False: this Mac never shows a desktop notification. */
  enabled: z.boolean(),
  /** Assistant ids (`nova`, `astra`) whose replies, questions and canvases stay quiet. */
  muted: z.array(z.string().min(1).max(128)).max(200),
})
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { enabled: true, muted: [] }

export const notificationsInvoke = {
  'notifications.get': { input: z.object({}).strict(), output: NotificationPrefsSchema },
  'notifications.set': {
    input: NotificationPrefsSchema.partial().strict(),
    output: NotificationPrefsSchema,
  },
  /**
   * What the window shows now, so a chat in front stays quiet: `assistant:<id>` for an assistant's
   * page and `chat:<session file>` for a chat, for every pane on screen.
   */
  'notifications.visible': {
    input: z.object({ threads: z.array(z.string().max(4096)).max(100) }).strict(),
    output: z.object({}),
  },
  /** Shows one notification now, past the focus and idle rules (the Send test button). */
  'notifications.test': {
    input: z.object({}).strict(),
    output: z.object({ shown: z.boolean() }),
  },
} as const

export const notificationsEvents = {
  'notifications.changed': NotificationPrefsSchema,
} as const
