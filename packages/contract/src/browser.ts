import { z } from 'zod'
import { AgentIdentitySchema, AgentRunOpSchema, AgentRunSchema } from './agent-presence'

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
  /**
   * The page asked for a passkey, which this browser can't offer: the panel shows the "Open in
   * <default browser>" bar until the page navigates, gets a credential, or the bar is dismissed.
   */
  passkey: z.boolean().optional(),
  /**
   * Who opened the tab, as a short label (a session title, a helper's name). Null or absent:
   * Isaac or the assistant itself. Tabs a page opens inherit their opener's.
   */
  openedBy: z.string().max(120).nullable().optional(),
  /** An agent's tab: who drives it and what it is doing (AgentRunSchema). */
  agent: AgentRunSchema.optional(),
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

/** One browser view on screen: the tab and its rect in window content coordinates. */
export const BrowserSlotSchema = z
  .object({
    tabId: TabIdSchema,
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    width: z.number().int().min(0),
    height: z.number().int().min(0),
  })
  .strict()
export type BrowserSlot = z.output<typeof BrowserSlotSchema>

/** Upper bound on browser views on screen at once. */
export const MAX_BROWSER_SLOTS = 16

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
  /** The app the asking tab shows (its own app, else the partition's `ecard_app` cookie). */
  active: z.boolean(),
})
export type SwitchApp = z.output<typeof SwitchAppSchema>

// Browser channels. Plans 01-08 and 01-09 extend these maps.
export const browserInvoke = {
  /** The tabs in front; with `scope`, what that scope shows when it is next in front. */
  'browser.state': {
    input: z.object({ scope: BrowserScopeSchema.optional() }).strict(),
    output: TabsSnapshotSchema,
  },
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
  /** Hides the tab's passkey bar. */
  'browser.dismissPasskey': { input: tabOnly, output: okOut },
  /** The macOS default browser's name (`Arc`), for "Open in Arc"; null when unknown. */
  'browser.systemBrowser': {
    input: z.object({}).strict(),
    output: z.object({ name: z.string().nullable() }),
  },
  /**
   * Exactly these tabs' views are on screen, each at its rect, in list order (later on top);
   * every other view leaves the screen. Any tab of any scope may be listed; a dormant one revives
   * and a listed tab is never sent dormant. An empty list shows no browser view.
   * `browser.setOccluded(true)` hides them all until it is cleared.
   */
  'browser.setSlots': {
    input: z.object({ slots: z.array(BrowserSlotSchema).max(MAX_BROWSER_SLOTS) }).strict(),
    output: okOut,
  },
  /**
   * The states of arbitrary tabs by id, whatever their scope (for page tabs of other scopes).
   * Unknown ids are left out.
   */
  'browser.tabs.get': {
    input: z.object({ ids: z.array(TabIdSchema).max(64) }).strict(),
    output: z.object({ tabs: z.array(TabStateSchema) }),
  },
  'browser.setOccluded': {
    input: z.object({ occluded: z.boolean() }).strict(),
    output: z.object({ visible: z.boolean() }),
  },
  /**
   * Rects of shell-drawn overlays that float over the browser views (toasts), in window content
   * coordinates. A view gives up the band next to each instead of painting over it; the page
   * stays visible. An empty list clears them.
   */
  'browser.setHoles': {
    input: z
      .object({
        holes: z
          .array(
            z
              .object({
                x: z.number().int(),
                y: z.number().int(),
                width: z.number().int().min(0),
                height: z.number().int().min(0),
              })
              .strict(),
          )
          .max(16),
      })
      .strict(),
    output: okOut,
  },
  /**
   * A new tab in `scope` (the scope in front when omitted) without switching scopes: that scope's
   * active tab, unless `background`. `openedBy` labels who asked for it (see TabState.openedBy);
   * `agent` makes it that agent's tab (idle until it drives it, see AgentRunSchema).
   */
  'browser.createTab': {
    input: z
      .object({
        url: z.string().max(2048).optional(),
        scope: BrowserScopeSchema.optional(),
        openedBy: z.string().max(120).optional(),
        background: z.boolean().optional(),
        agent: AgentIdentitySchema.optional(),
      })
      .strict(),
    output: TabStateSchema,
  },
  /** Isaac's controls on an agent's tab (AgentRunOpSchema). */
  'browser.agent': {
    input: z.object({ tabId: TabIdSchema, op: AgentRunOpSchema }).strict(),
    output: okOut,
  },
  /**
   * Isaac marks something on the page (clicks an element or drags a region) and writes a note:
   * it goes to the chat that owns the tab, with the element or region, a screenshot of it and the
   * URL. Resolves once he sends or cancels (Escape); `to` is the chat's name.
   */
  'browser.annotate': {
    input: z.object({ tabId: TabIdSchema }).strict(),
    output: z.object({
      sent: z.boolean(),
      to: z.string().max(200).nullable(),
      cancelled: z.boolean(),
    }),
  },
  'browser.closeTab': {
    input: tabOnly,
    output: z.object({ activeId: z.string() }),
  },
  /** With `scope` (not in front), the tab that scope shows next; the tabs in front stay. */
  'browser.activateTab': {
    input: z.object({ tabId: TabIdSchema, scope: BrowserScopeSchema.optional() }).strict(),
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
  /** The local eCard app switch's apps, with the app tab `tabId` shows (if given) marked active. */
  'browser.switchApps': {
    input: z.object({ tabId: TabIdSchema.optional() }).strict(),
    output: z.object({ apps: z.array(SwitchAppSchema) }),
  },
  /** Points one tab at another app (other tabs keep theirs) and reloads it. */
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
  /**
   * A new tab for the shell to show as a page tab: a guest page opened it (target=_blank,
   * window.open; `openerId`, beside whose page tab it goes) or an extension did (no opener). It is
   * in `scope`, not made active there. `background`: a Cmd-click (Chromium's background-tab
   * disposition), so it opens without coming to the front.
   */
  'browser.popup': z.object({
    tabId: TabIdSchema,
    openerId: TabIdSchema.optional(),
    scope: z.string(),
    background: z.boolean().optional(),
  }),
} as const
