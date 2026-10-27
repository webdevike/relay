import { z } from 'zod'

export const TabIdSchema = z.string().regex(/^t[0-9]{1,6}$/)

export const TabStateSchema = z.object({
  id: TabIdSchema,
  url: z.string(),
  title: z.string(),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  blank: z.boolean(),
  error: z.object({ host: z.string(), code: z.number() }).nullable(),
  favicon: z.string().nullable(),
  /** Pinned tabs belong to no session and show in every scope. */
  pinned: z.boolean(),
})
export type TabState = z.output<typeof TabStateSchema>

/** A browser scope: the session or page in front (`chat:…`, `draft:…`, `page:…`). */
export const BrowserScopeSchema = z.string().min(1).max(1024)

/** The tabs visible in the current scope: pinned tabs first, then the scope's own tabs. */
export const TabsSnapshotSchema = z.object({
  tabs: z.array(TabStateSchema),
  activeId: z.string(),
  scope: z.string().max(1024),
})
export type TabsSnapshot = z.output<typeof TabsSnapshotSchema>

const tabOnly = z.object({ tabId: TabIdSchema }).strict()
const okOut = z.object({ ok: z.literal(true) })

/** A registered app of the local eCard app switch (`GET /__apps` on https://localhost:3001). */
export const SwitchAppIdSchema = z.string().regex(/^[\w-]{1,64}$/)
export const SwitchAppSchema = z.object({
  id: SwitchAppIdSchema,
  /** `ENG-6476`, when the worktree or branch names one. */
  ticket: z.string().nullable(),
  /** The ticket's ledger title, else the id. */
  title: z.string(),
  branch: z.string().nullable(),
  port: z.number().int().min(1).max(65535),
  /** Relative to the Eva root. */
  worktree: z.string(),
  api: z.string(),
  running: z.boolean(),
  /** The app the browser's `ecard_app` cookie picks. */
  active: z.boolean(),
})
export type SwitchApp = z.output<typeof SwitchAppSchema>

// Browser channels. Plans 01-08 and 01-09 extend these maps.
export const browserInvoke = {
  'browser.state': { input: z.object({}).strict(), output: TabsSnapshotSchema },
  'browser.navigate': {
    input: z.object({ tabId: TabIdSchema, input: z.string().max(2048) }).strict(),
    output: z.object({ url: z.string().nullable() }),
  },
  'browser.back': { input: tabOnly, output: okOut },
  'browser.forward': { input: tabOnly, output: okOut },
  'browser.reload': { input: tabOnly, output: okOut },
  'browser.stop': { input: tabOnly, output: okOut },
  'browser.copyLink': { input: tabOnly, output: okOut },
  'browser.openExternal': { input: tabOnly, output: okOut },
  'browser.setSlot': {
    input: z
      .object({
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        width: z.number().int().min(0),
        height: z.number().int().min(0),
      })
      .strict(),
    output: okOut,
  },
  'browser.setOccluded': {
    input: z.object({ occluded: z.boolean() }).strict(),
    output: z.object({ visible: z.boolean() }),
  },
  'browser.createTab': {
    input: z.object({ url: z.string().max(2048).optional() }).strict(),
    output: TabStateSchema,
  },
  'browser.closeTab': {
    input: tabOnly,
    output: z.object({ activeId: z.string() }),
  },
  'browser.activateTab': {
    input: tabOnly,
    output: z.object({ activeId: z.string() }),
  },
  'browser.suggest': {
    input: z.object({ text: z.string().max(512) }).strict(),
    output: z.object({
      items: z.array(z.object({ url: z.string(), title: z.string() })).max(6),
    }),
  },
  'browser.openDevTools': { input: tabOnly, output: okOut },
  'browser.extensions': {
    input: z.object({}).strict(),
    output: z.object({
      extensions: z.array(z.object({ id: z.string(), name: z.string(), version: z.string() })),
    }),
  },
  'browser.importArc': {
    input: z.object({}).strict(),
    output: z.object({ count: z.number().int().min(0) }),
  },
  'browser.setScope': {
    input: z.object({ scope: BrowserScopeSchema }).strict(),
    output: TabsSnapshotSchema,
  },
  /** A draft chat that got its session file keeps its tabs under the new scope. */
  'browser.renameScope': {
    input: z.object({ from: BrowserScopeSchema, to: BrowserScopeSchema }).strict(),
    output: okOut,
  },
  'browser.pinTab': {
    input: z.object({ tabId: TabIdSchema, pinned: z.boolean() }).strict(),
    output: TabsSnapshotSchema,
  },
  /** The local eCard app switch's apps, as the browser session's cookie sees them. */
  'browser.switchApps': {
    input: z.object({}).strict(),
    output: z.object({ apps: z.array(SwitchAppSchema) }),
  },
  /** Points the switch at another app (its cookie, in the browser session) and reloads the tab. */
  'browser.switchApp': {
    input: z.object({ tabId: TabIdSchema, id: SwitchAppIdSchema }).strict(),
    output: z.object({ active: SwitchAppIdSchema }),
  },
} as const

export const HotkeyChordSchema = z.enum([
  'new-tab',
  'close-tab',
  'focus-address',
  'search',
  'eregon',
  'new-todo',
  'toggle-panel',
  'prev-tab',
  'next-tab',
])
export type HotkeyChord = z.output<typeof HotkeyChordSchema>

export const browserEvents = {
  'browser.tabs': TabsSnapshotSchema,
  'browser.hotkey': z.object({ chord: HotkeyChordSchema }),
  /** A short, user-facing note from the browser host (for example the tab limit). */
  'browser.notice': z.object({ message: z.string().max(200) }),
} as const
