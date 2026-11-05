import { z } from 'zod'
import { SwitchAppIdSchema, TabIdSchema } from './browser'
import { ContextScopeSchema, PinIdSchema, PinRefSchema } from './context'
import {
  ArtifactKind,
  ArtifactTabIcon,
  MAX_PIN_LABEL,
  MAX_PIN_VALUE,
  PinKind,
  TabRule,
} from '@evaos/chat-core/artifacts'
import { CanvasLiveSlugSchema } from '@evaos/chat-core/canvas-live'
import {
  MAX_STUDIO_PROMPT,
  MAX_STUDIO_REFS,
  StudioAspectSchema,
  StudioBackendIdSchema,
  StudioDraftSchema,
  StudioJobStateSchema,
  StudioModeSchema,
} from './studio'
import {
  AGENT_FIXED_PAGES,
  AgentLinkParamsSchema,
  AgentSettingKeySchema,
  AgentSettingsSectionSchema,
  ConnectionIdSchema,
  LinearKeySchema,
  TourTargetSchema,
  parseSettingValue,
} from './agent-access'
import { parseAppLink } from '@evaos/chat-core/widget'

/**
 * Agent control: every user-reachable action an agent (Eva, Nova, any omp session) may run in the
 * app, one typed entry each. Main serves the catalog over the loopback control API
 * (main/agent-control) and runs `side: 'main'` entries itself; `side: 'renderer'` entries run in
 * the shell page (renderer/agent). A new entry here fails typecheck until its side implements it.
 *
 * `focus` names what an action replaces: `main` the chat pane (page, chat, app tab; tool tabs
 * follow the page's scope), `panel` what the tool panes show or how they are laid out, `none`
 * nothing on screen. While Isaac types in a text field the action would replace (anywhere for
 * `main`, inside a tool pane for `panel`), it waits in a queue instead of running.
 * `destructive` actions need `confirm: true` from the agent and Isaac's approval in the app.
 *
 * The window shows one workspace at a time (shell-core workspace.ts): an assistant (its thread and
 * every session it owns), a plain chat, or a page. Each workspace has its own tiling of panes: app
 * tabs (its chats or page) and tool tabs (web pages, files, terminal, transcripts, arm details,
 * pages beside the chat). Pinned tabs show in every workspace. `layout.read` shows a workspace's
 * tree; `pane.*` and `tab.*` change it.
 *
 * Content actions (files.open, browser.*, tab.open, testbench.open with an arm) and the layout
 * actions (layout.read, pane.*) take an optional `scope`: the page or chat whose workspace they act
 * on (AgentScopeSchema; a session an assistant owns resolves to that assistant's workspace). A
 * workspace that is not on screen gets the change in its own layout, without switching workspaces
 * or taking focus; its sidebar row shows a quiet dot until Isaac opens it. A request's `scope`
 * (relay-ctl sends the caller's own) fills in for `panel` actions that name none, and for `scoped`
 * actions (artifacts.*, layout.read), which act on the caller's own thread or workspace.
 */
export type AgentSide = 'main' | 'renderer'
export type AgentFocus = 'none' | 'panel' | 'main'

export interface AgentActionSpec {
  title: string
  description: string
  params: z.ZodType
  side: AgentSide
  focus: AgentFocus
  destructive: boolean
  /** Takes the request's `scope` like a panel action, without touching the panel. */
  scoped?: boolean
}

/** Hotkey-router actions (shell-core ActionId) an agent may run; `focus-search` is left out. */
export const AGENT_SHORTCUTS = [
  'new-todo',
  'reload',
  'toggle-sidebar',
  'toggle-panel',
  'new-tab',
  'close-tab',
  'history-back',
  'history-forward',
  'dismiss',
] as const

const Empty = z.object({}).strict()
const TabNumber = z.number().int().min(0)

/**
 * Where a panel action lands: a page key (`agent:nova`, `test-bench`, `workspace:<slug>`), a chat
 * session id or session file, or a browser scope (`page:…`, `chat:…`). Omitted: the page in front.
 */
export const AgentScopeSchema = z.string().min(1).max(4096)
const scope = AgentScopeSchema.optional()

/** A pane id from layout.read (`p1`, `p2`...; ids are per workspace). */
const PaneId = z.string().min(1).max(64)
/** A tool tab's id from layout.read (`web:<page id>`, `files`, `subagent:<file>`, `view:test-bench`...). */
const PaneTabId = z.string().min(1).max(4200)
const Side = z.enum(['right', 'left', 'down', 'up'])
const Share = z.number().gt(0).lt(1)

/** A Reviews item link: `https://github.com/<owner>/<repo>/pull/<n>`, a Linear issue or a Slack message. */
const ReviewItemUrl = z.string().url().max(2048)

const PageTabArgs = z
  .object({
    page: z.union([
      z.enum(AGENT_FIXED_PAGES).exclude(['chat']),
      z
        .string()
        .max(300)
        .regex(/^(workspace|board):.+$/),
    ]),
    settingsSection: AgentSettingsSectionSchema.optional(),
    canvas: z.string().max(200).optional(),
    meeting: z.string().max(500).optional(),
    /** Reviews only: the item to open (a GitHub PR, Linear issue or Slack message link). */
    item: ReviewItemUrl.optional(),
  })
  .strict()

/** What a tool tab shows, with what it needs to show it. */
export const PaneTabSpecSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('browser'),
      args: z
        .object({ url: z.string().min(1).max(2048).optional() })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('files'),
      args: z
        .object({
          path: z.string().min(1).max(4096).optional(),
          line: z.number().int().min(1).optional(),
          column: z.number().int().min(1).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('terminal'),
      args: z.object({}).strict().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('subagent'),
      args: z
        .object({
          session: z.string().min(1).max(4096),
          file: z.string().min(1).max(4096),
          name: z.string().min(1).max(200),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('experiment-arm'),
      args: z
        .object({ experiment: z.string().min(1).max(200), arm: z.string().min(1).max(200) })
        .strict(),
    })
    .strict(),
  z.object({ kind: z.literal('page'), args: PageTabArgs }).strict(),
])
export type PaneTabSpec = z.output<typeof PaneTabSpecSchema>

const ArtifactItemId = z.string().min(1).max(2100)
const ArtifactTabId = z.string().min(1).max(48)
const ARTIFACTS_SCOPE =
  "Acts on the calling session's thread (an assistant's whole thread, else the chat's)."

export const agentActions = {
  'state.read': {
    title: 'Read state',
    description:
      'What is on screen: the window (focused or not), the page and app tabs, the open chat (with its unsent composer draft), the pane layout (as layout.read), the web pages of the workspace on screen (`browser`: id, url, title, whether each shows), the Files tab, and a text summary of the chat pane and each tool pane on screen.',
    params: Empty,
    side: 'main',
    focus: 'none',
    destructive: false,
  },
  'layout.read': {
    title: 'Read the pane layout',
    description:
      "A workspace's split tree (the caller's own, else `scope`'s, else the one on screen): each split (row = side by side, column = stacked) with its children's shares, each pane with its id, tabs (id, kind, title, args, pinned), the tab in front, its px rect and whether it is on screen; the focused pane and the zoomed one; `workspace` (its key) and `shown` (on screen or not). Panes holding app tabs hold the workspace's chats or page; tool panes hold the rest.",
    params: z.object({ scope }).strict(),
    side: 'renderer',
    focus: 'none',
    destructive: false,
    scoped: true,
  },
  'window.screenshot': {
    title: 'Screenshot the window',
    description:
      'PNG of the app window (shell plus the visible browser view), base64. Never shows or focuses the window. GET /screenshot returns the raw PNG.',
    params: Empty,
    side: 'main',
    focus: 'none',
    destructive: false,
  },
  'app.quit': {
    title: 'Quit Relay',
    description: 'Quits the app through its normal quit guard (unsaved edits still ask).',
    params: Empty,
    side: 'main',
    focus: 'none',
    destructive: true,
  },
  'update.offer': {
    title: 'Offer an update',
    description:
      'Tells the app a new build is ready: Isaac sees "Update ready" with Restart now and Later, and the app restarts into it on its own once he has been idle 2 minutes with no chat running (exit code 75; the supervisor relaunches it). Offering again replaces the pending update.',
    params: z
      .object({ summary: z.string().min(1).max(200), build: z.string().min(1).max(64) })
      .strict(),
    side: 'main',
    focus: 'none',
    destructive: false,
  },
  'page.open': {
    title: 'Open a page',
    description:
      'Opens a page in the current app tab (or a new one): a top-level page slug, or `workspace:<slug>`, `agent:<id>`, `board:<slug>`. For `reviews`, `item` opens that pull request, Linear issue or Slack thread (its link). To show it beside the chat instead, use tab.open with kind `page` and args {page: "reviews", item}.',
    params: z
      .object({
        page: z.union([
          z.enum(AGENT_FIXED_PAGES),
          z
            .string()
            .max(300)
            .regex(/^(workspace|agent|board):.+$/),
        ]),
        newTab: z.boolean().optional(),
        settingsSection: AgentSettingsSectionSchema.optional(),
        canvas: z.string().max(200).optional(),
        meeting: z.string().max(500).optional(),
        item: ReviewItemUrl.optional(),
      })
      .strict(),
    side: 'renderer',
    focus: 'main',
    destructive: false,
  },
  'tab.focus': {
    title: 'Focus a tab',
    description:
      'Brings a tab to the front: an app tab by its number (state.read lists them; switches the page), or a tool tab by its id (layout.read lists them; shows it in its pane and focuses the pane).',
    params: z.object({ id: z.union([TabNumber, PaneTabId]) }).strict(),
    side: 'renderer',
    focus: 'main',
    destructive: false,
  },
  'tab.close': {
    title: 'Close a tab',
    description:
      'Closes an app tab by its number (chats stay in the chat list) or a tool tab by its id (a pane left empty closes; a page tab `web:<id>` closes its page, Files keeps its open files).',
    params: z.object({ id: z.union([TabNumber, PaneTabId]) }).strict(),
    side: 'renderer',
    focus: 'main',
    destructive: false,
  },
  'tab.open': {
    title: 'Open a tool tab',
    description:
      "Shows a tool tab: `browser` (a new web page as its own page tab, args.url loaded in it; a blank page without one), `files` (args.path shows a file or folder, at args.line), `terminal` (a shell in the chat folder, or the herdr session of the chat), `subagent` (args: session file, subagent .jsonl, name), `experiment-arm` (args: experiment, arm) or `page` (args.page: test-bench, canvas with args.canvas, studio, jobs, a workspace:<slug>...; not chats). Already open: it comes to the front (moved to `pane` when one is named). Else it opens in `pane`, the focused or last tool pane, or a new pane right of the chat; a `browser` page goes to `pane`, else the pane holding the workspace's pages, else a new pane right of the chat. Answers the pane and tab ids (a page also its `tabId`).",
    params: z
      .object({
        kind: z.enum(['browser', 'files', 'terminal', 'subagent', 'experiment-arm', 'page']),
        args: z.record(z.string(), z.unknown()).optional(),
        pane: PaneId.optional(),
        scope,
      })
      .strict()
      .superRefine((v, ctx) => {
        const spec = PaneTabSpecSchema.safeParse(
          v.args === undefined ? { kind: v.kind } : { kind: v.kind, args: v.args },
        )
        for (const issue of spec.success ? [] : spec.error.issues) {
          ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path })
        }
      }),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
  },
  'pane.split': {
    title: 'Split a pane',
    description:
      "Splits `pane` (default: the focused one; a split id from layout.read puts the new pane beside that whole group) toward `dir` with a new pane showing `tab`: a tool tab id (moved there) or `{kind, args}` as tab.open takes it. Without `tab`, the pane's tab in front moves over when it has others, else the first tool not open yet. `size` is the new pane's share (0 to 1, default half). Acts in the caller's workspace (`scope`); one not on screen changes without showing. Answers the new pane id and the layout.",
    params: z
      .object({
        pane: PaneId.optional(),
        dir: Side,
        tab: z.union([PaneTabId, PaneTabSpecSchema]).optional(),
        size: Share.optional(),
        scope,
      })
      .strict(),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
  },
  'pane.close': {
    title: 'Close a pane',
    description:
      "Closes a tool pane and its tabs in the caller's workspace (`scope`). A pane holding the workspace's chat never closes; to hide every tool pane, pane.zoom that pane.",
    params: z.object({ pane: PaneId, scope }).strict(),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
  },
  'pane.move': {
    title: 'Move a tab to a pane',
    description:
      "Moves tab `tab` (its id) into pane `toPane` at `index` (default after the tab in front), within the caller's workspace (`scope`). A pane left empty closes.",
    params: z
      .object({
        tab: PaneTabId,
        toPane: PaneId,
        index: z.number().int().min(0).optional(),
        scope,
      })
      .strict(),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
  },
  'pane.resize': {
    title: 'Resize a pane',
    description:
      "Sets a pane's (or split's) size within its parent split, in the caller's workspace (`scope`): `size` as a share (0 to 1) or `px` along the split's direction. Its siblings keep their proportions; a chat pane keeps at least 480px wide and a tool pane 240px.",
    params: z
      .object({
        pane: PaneId,
        size: Share.optional(),
        px: z.number().int().min(1).optional(),
        scope,
      })
      .strict()
      .refine((v) => (v.size === undefined) !== (v.px === undefined), {
        message: 'give size or px',
      }),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
  },
  'pane.focus': {
    title: 'Focus a pane',
    description:
      "Makes `pane`, or the pane next to the focused one toward `dir`, the focused pane of the caller's workspace (`scope`): new tabs and pane shortcuts go there. Never moves Isaac's keyboard focus.",
    params: z
      .object({ pane: PaneId.optional(), dir: Side.optional(), scope })
      .strict()
      .refine((v) => (v.pane === undefined) !== (v.dir === undefined), {
        message: 'give pane or dir',
      }),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
  },
  'pane.zoom': {
    title: 'Maximize a pane',
    description:
      "Maximizes `pane` (default: the focused one) over the others in the caller's workspace (`scope`), or with `on: false` shows every pane again; without `on` it toggles. Zooming the chat's pane hides the tool panes (the panel toggle, Cmd+Shift+B).",
    params: z.object({ pane: PaneId.optional(), on: z.boolean().optional(), scope }).strict(),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
  },
  'chat.open': {
    title: 'Open a chat',
    description:
      'Opens a chat by session id, session file path, or words of its title (must match exactly one chat).',
    params: z
      .object({ query: z.string().min(1).max(4096), newTab: z.boolean().optional() })
      .strict(),
    side: 'renderer',
    focus: 'main',
    destructive: false,
  },
  'chat.new': {
    title: 'New chat',
    description: 'Opens an empty New chat tab. Sends nothing.',
    params: Empty,
    side: 'renderer',
    focus: 'main',
    destructive: false,
  },
  'chat.start': {
    title: 'Start a chat with a prompt',
    description: 'Opens a new chat and sends the prompt as Isaac. Needs confirm and his approval.',
    params: z.object({ prompt: z.string().min(1).max(200_000) }).strict(),
    side: 'renderer',
    focus: 'main',
    destructive: true,
  },
  'files.open': {
    title: 'Open in Files',
    description:
      "Shows a file or folder in the Files tab (opened in a tool pane when it is not on screen). A folder expands, scrolls into view and is selected in the tree; a file opens in the editor (at `line`). Paths are absolute or Eva-relative; outside the open chat's worktree Files switches to the Eva root.",
    params: z
      .object({
        path: z.string().min(1).max(4096),
        line: z.number().int().min(1).optional(),
        column: z.number().int().min(1).optional(),
        scope,
      })
      .strict(),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
  },
  'browser.open': {
    title: 'Open a web page',
    description:
      'Opens a URL (or a bare local port like `3000`) as a new page tab of the workspace (`web:<tabId>`): in the pane holding its pages, else a new pane right of the chat. With `scope` it lands in that workspace (in the background, with a quiet dot, when it is not on screen); a session an assistant owns marks the page as opened by it. Answers `pane`, `tab` and `tabId`.',
    params: z.object({ url: z.string().min(1).max(2048), scope }).strict(),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
  },
  'browser.focusTab': {
    title: 'Show a web page',
    description:
      "Brings a page's tab (`tabId` from state.read or layout.read `args.tabId`) to the front of its pane, in the workspace that holds it (one not on screen changes without showing). A page with no tab gets one.",
    params: z.object({ tabId: TabIdSchema, scope }).strict(),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
  },
  'browser.closeTab': {
    title: 'Close a web page',
    description: 'Closes a page by id: its page tab and the page.',
    params: z.object({ tabId: TabIdSchema, scope }).strict(),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
  },
  'ecard.switch': {
    title: 'Switch the eCard app',
    description:
      "Lists the local eCard app switch's apps (active = the app of the page last focused); with `id`, points only that page at the app and reloads it. Other pages keep their own apps.",
    params: z.object({ id: SwitchAppIdSchema.optional(), scope }).strict(),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
  },
  'testbench.open': {
    title: 'Open Test Bench',
    description:
      "Opens the Test Bench page; with `experiment` (folder under work/experiments) opens that run, and with `arm` also the arm details in a tool tab. With `scope` (needs `arm`) it stays on the current page and shows only the arm details, in that scope's tool tabs.",
    params: z
      .object({
        experiment: z.string().min(1).max(200).optional(),
        arm: z.string().min(1).max(200).optional(),
        scope,
      })
      .strict()
      .refine((v) => v.arm === undefined || v.experiment !== undefined, {
        message: 'arm needs experiment',
      })
      .refine((v) => v.scope === undefined || v.arm !== undefined, {
        message: 'scope needs arm',
      }),
    side: 'renderer',
    focus: 'main',
    destructive: false,
  },
  'context.open': {
    title: 'Open the context popover',
    description:
      'Opens the header popover left of the panel toggle: pins on top, then what is live in the chat or assistant thread in front (`scope: here`, the default) or everywhere (running jobs, Test Bench runs, every assistant). Returns what it shows.',
    params: z.object({ scope: ContextScopeSchema.optional() }).strict(),
    side: 'renderer',
    focus: 'none',
    destructive: false,
  },
  'context.read': {
    title: 'Read the context popover',
    description:
      'What the context popover shows for the chat or thread in front, without opening it: its button label and dot, pins, sections and rows (each with its `pin` ref), quick actions and the jobs and Test Bench footer.',
    params: z.object({ scope: ContextScopeSchema.optional() }).strict(),
    side: 'renderer',
    focus: 'none',
    destructive: false,
  },
  'context.pin': {
    title: 'Pin to the context popover',
    description:
      'Pins a PR (`{kind:"pr", repo:"owner/name", number}`), work item (`{kind:"item", key}`), Test Bench experiment (`{kind:"experiment", id}`), job (`{kind:"job", name}`) or chat or subagent transcript (`{kind:"session", file, title}`) to the top of the context popover in every chat. Pins persist across restarts.',
    params: z.object({ ref: PinRefSchema }).strict(),
    side: 'renderer',
    focus: 'none',
    destructive: false,
  },
  'context.unpin': {
    title: 'Unpin from the context popover',
    description:
      'Removes a pin by id: `pr:<owner/name>#<number>`, `item:<key>`, `experiment:<id>`, `job:<name>` or `session:<file>`.',
    params: z.object({ id: PinIdSchema }).strict(),
    side: 'renderer',
    focus: 'none',
    destructive: false,
  },
  'toast.show': {
    title: 'Show a toast',
    description: 'Shows a short in-app notification.',
    params: z
      .object({
        message: z.string().min(1).max(500),
        title: z.string().max(120).optional(),
        color: z.enum(['blue', 'green', 'red', 'yellow', 'gray']).optional(),
      })
      .strict(),
    side: 'renderer',
    focus: 'none',
    destructive: false,
  },
  'shortcut.run': {
    title: 'Run a shortcut action',
    description: 'Runs a hotkey-router action, as its keyboard shortcut would.',
    params: z.object({ action: z.enum(AGENT_SHORTCUTS) }).strict(),
    side: 'renderer',
    focus: 'main',
    destructive: false,
  },
  'artifacts.list': {
    title: "List the thread's artifacts",
    description: `${ARTIFACTS_SCOPE} Without \`tab\`: every tab (id, title, rule or items, who made it, hidden) and the Everything tab's items. With \`tab\`: that tab's items (id, kind, title, url or path, state, pinned). Check the default tabs (links, media, subagents, everything) here before adding a tab.`,
    params: z.object({ tab: ArtifactTabId.optional(), scope }).strict(),
    side: 'main',
    focus: 'none',
    destructive: false,
    scoped: true,
  },
  'artifacts.add': {
    title: 'Add an artifact',
    description: `${ARTIFACTS_SCOPE} Adds something no message holds (a link, file, ticket); \`tab\` also files it under that item tab. Answers its id.`,
    params: z
      .object({
        kind: ArtifactKind,
        title: z.string().trim().min(1).max(300),
        url: z.string().min(1).max(2048).optional(),
        path: z.string().min(1).max(1024).optional(),
        caption: z.string().max(300).optional(),
        tab: ArtifactTabId.optional(),
        scope,
      })
      .strict(),
    side: 'main',
    focus: 'none',
    destructive: false,
    scoped: true,
  },
  'artifacts.pin': {
    title: 'Pin an artifact',
    description: `${ARTIFACTS_SCOPE} Pins item \`id\` (from artifacts.list) to the top of its tabs; pinned items never fade.`,
    params: z.object({ id: ArtifactItemId, scope }).strict(),
    side: 'main',
    focus: 'none',
    destructive: false,
    scoped: true,
  },
  'artifacts.unpin': {
    title: 'Unpin an artifact',
    description: `${ARTIFACTS_SCOPE} Unpins item \`id\`.`,
    params: z.object({ id: ArtifactItemId, scope }).strict(),
    side: 'main',
    focus: 'none',
    destructive: false,
    scoped: true,
  },
  'artifacts.tab.add': {
    title: 'Add an artifacts tab',
    description: `${ARTIFACTS_SCOPE} Adds a tab after the defaults. Reuse the default tabs first (filter Links or Everything with artifacts.list); add a tab only for a view that lasts, and prefer a \`rule\` (kept up to date by the host, e.g. {"kind":["gh-pr"],"state":["open"]}) over a hand-kept \`items\` list. Refused when it repeats a default, a tab Isaac hid, or a visible tab; the refusal says why. Answers the tab id.`,
    params: z
      .object({
        title: z.string().trim().min(1).max(40),
        icon: ArtifactTabIcon.optional(),
        rule: TabRule.optional(),
        items: z.array(ArtifactItemId).max(500).optional(),
        scope,
      })
      .strict(),
    side: 'main',
    focus: 'none',
    destructive: false,
    scoped: true,
  },
  'artifacts.tab.update': {
    title: 'Change an artifacts tab',
    description: `${ARTIFACTS_SCOPE} Renames, re-rules, refiles or moves (\`index\` in the full bar) a tab you made.`,
    params: z
      .object({
        id: ArtifactTabId,
        title: z.string().trim().min(1).max(40).optional(),
        icon: ArtifactTabIcon.optional(),
        rule: TabRule.optional(),
        items: z.array(ArtifactItemId).max(500).optional(),
        index: z.number().int().nonnegative().optional(),
        scope,
      })
      .strict(),
    side: 'main',
    focus: 'none',
    destructive: false,
    scoped: true,
  },
  'artifacts.tab.remove': {
    title: 'Remove an artifacts tab',
    description: `${ARTIFACTS_SCOPE} Removes a tab you made. Defaults are never removed.`,
    params: z.object({ id: ArtifactTabId, scope }).strict(),
    side: 'main',
    focus: 'none',
    destructive: false,
    scoped: true,
  },
  'pins.list': {
    title: "List the thread's pins",
    description: `${ARTIFACTS_SCOPE} Everything pinned in the rail beside the chat, newest first: id, kind, label, value, who pinned it (\`isaac\` or an assistant) and the message it came from.`,
    params: z.object({ scope }).strict(),
    side: 'main',
    focus: 'none',
    destructive: false,
    scoped: true,
  },
  'pins.add': {
    title: 'Pin something for Isaac',
    description: `${ARTIFACTS_SCOPE} Pins a snippet in the rail beside the chat, where Isaac copies or opens it in one click. Pin what he will need again: a URL he must open later, a code or number, a file path, a command; never routine links or things the reply already makes easy to find. \`kind\`: link, text, code, number, file, pr, item or message; \`label\` is the short name shown, \`value\` what Copy copies. Pinning the same kind and value again changes nothing. Answers the pin's id. Without this tool, a reply line \`[[pin: <label> | <value>]]\` pins the same way (a value in backticks is code).`,
    params: z
      .object({
        kind: PinKind,
        label: z.string().trim().min(1).max(MAX_PIN_LABEL),
        value: z.string().min(1).max(MAX_PIN_VALUE),
        scope,
      })
      .strict(),
    side: 'main',
    focus: 'none',
    destructive: false,
    scoped: true,
  },
  'pins.remove': {
    title: 'Unpin',
    description: `${ARTIFACTS_SCOPE} Removes pin \`id\` (from pins.list or pins.add). You remove only pins you made; one of Isaac's or another assistant's is refused unless \`force\` is true, which only an explicit ask from Isaac to remove it justifies.`,
    params: z.object({ id: ArtifactItemId, force: z.boolean().optional(), scope }).strict(),
    side: 'main',
    focus: 'none',
    destructive: false,
    scoped: true,
  },
  'canvas.live': {
    title: 'Start a live canvas with Isaac',
    description:
      "Takes the calling session onto a board with Isaac (the request's scope: an assistant's thread, else the chat's session file). The Relay host opens a live room on board `slug`, or on a new board titled `title` (neither: the host picks), with this session as the agent at the board: same name and look, this chat as context. Isaac gets a Join card in this chat; each canvas turn and the wrap-up come back here. `prompt` is what the canvas session is for (the card shows it). Answers the host's {roomId, slug, board, agent, joinPath}.",
    params: z
      .object({
        slug: CanvasLiveSlugSchema.optional(),
        title: z.string().trim().min(1).max(200).optional(),
        prompt: z.string().trim().min(1).max(4000).optional(),
        scope,
      })
      .strict(),
    side: 'main',
    focus: 'none',
    destructive: false,
    scoped: true,
  },
  'studio.generate': {
    title: 'Generate an image or video in Studio',
    description:
      "Queues one free Studio job on the Relay host as the agent (origin `agent`) and answers `{job}` (id, state, prompt, backend, progress, eta, outputs). `mode` defaults to the backend's, else image. `backend` defaults to `ltx` (local video) for video, `codex-image` for image, `codex-edit` when `refs` are given. `aspect` defaults to 16:9 for video and 1:1 for image; `resolution` (an id studio.list shows per backend) to the first the backend offers for that aspect; `seconds` (video) to its first allowed length. `frames` ({start, mid, end}) and `refs` take asset ids from studio.list outputs. `comfyui` (images) and `comfyui-video` run presets: `model` is a preset id from that backend's `models` (Angles, Relight, Upscale...), `params` sets its `inputs` by id (a choice's option id or a number); a preset whose `prompt` is false ignores the prompt. A paid backend (higgsfield) is refused: open it as a draft with studio.open so Isaac sees the cost and confirms it himself. `open: true` also shows the job in the Studio tool tab of the calling scope (never takes focus). Poll studio.list for progress.",
    params: z
      .object({
        prompt: z.string().trim().min(1).max(MAX_STUDIO_PROMPT),
        mode: StudioModeSchema.optional(),
        backend: StudioBackendIdSchema.optional(),
        aspect: StudioAspectSchema.optional(),
        resolution: z.string().min(1).max(40).optional(),
        seconds: z.number().min(1).max(20).optional(),
        seed: z.number().int().min(0).max(2_147_483_647).optional(),
        frames: z
          .object({
            start: z.string().min(1).max(100).optional(),
            mid: z.string().min(1).max(100).optional(),
            end: z.string().min(1).max(100).optional(),
          })
          .strict()
          .optional(),
        refs: z.array(z.string().min(1).max(100)).max(MAX_STUDIO_REFS).optional(),
        model: z.string().min(1).max(100).optional(),
        params: z
          .record(z.string().min(1).max(40), z.union([z.string().max(200), z.number()]))
          .optional(),
        open: z.boolean().optional(),
        scope,
      })
      .strict(),
    side: 'main',
    focus: 'none',
    destructive: false,
    scoped: true,
  },
  'studio.list': {
    title: 'List Studio jobs',
    description:
      "Studio on the Relay host: its backends (id, label, mode, paid, available with the reason when not, resolutions, seconds, frames, refs, models, balance) and its jobs newest first (id, state, prompt, mode, backend, model, progress 0 to 1, eta, note, error, outputs). Each output has an `id` (usable in studio.generate `frames`/`refs`), `url` and `thumb` on the host's http origin (`http://127.0.0.1:<port>/studio/...`, no auth needed), kind, mimeType, width, height, durationMs and size in bytes. `state` keeps only jobs in that state; `limit` caps the jobs (default 20, at most 100).",
    params: z
      .object({
        state: StudioJobStateSchema.optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .strict(),
    side: 'main',
    focus: 'none',
    destructive: false,
  },
  'studio.open': {
    title: 'Open Studio',
    description:
      "Shows the Studio page as a tool tab in the calling scope's tool panes (a background scope gets it when Isaac opens that page; never takes focus). With `job` (an id from studio.list) it opens that job's output in the viewer. With `draft` (any part of a spec: prompt, mode, backend, aspect, resolution, seconds, seed, frames, refs, model) it fills the composer and sends nothing: Isaac reviews it and presses Generate himself (for a paid backend he confirms the cost there). Use this for anything paid.",
    params: z
      .object({
        job: z.string().min(1).max(100).optional(),
        draft: StudioDraftSchema.optional(),
        scope,
      })
      .strict()
      .refine((v) => v.job === undefined || v.draft === undefined, {
        message: 'give job or draft, not both',
      }),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
  },
  describe: {
    title: 'Describe the screen',
    description:
      'What Isaac sees now, in plain words and as data: the page in front (its title, Settings section, open chat, Reviews item, board) with its deep link, what is selected, where his caret is in a file (`editor`: absolute `file`, `line`, `column`, `selection` and `selectedText` when he selected something, `device` when it is on his other Mac, else null), each pane on screen with its tabs, the controls on screen a tour can point at (`target`, label), and whether the window is in front. Changes nothing.',
    params: Empty,
    side: 'renderer',
    focus: 'none',
    destructive: false,
  },
  'pages.list': {
    title: 'List the pages',
    description:
      'Every page and Settings section: its key, what it shows, its relay:// deep link, and which actions and settings read or change it there.',
    params: Empty,
    side: 'main',
    focus: 'none',
    destructive: false,
  },
  'settings.get': {
    title: 'Read settings',
    description:
      'Every setting an agent may change (or one `key`, or one `section`): key, title, Settings section, current value, the values it takes when they are few (theme presets with their names, light/dark, primary colors), and its deep link.',
    params: z
      .object({
        key: AgentSettingKeySchema.optional(),
        section: AgentSettingsSectionSchema.optional(),
      })
      .strict(),
    side: 'renderer',
    focus: 'none',
    destructive: false,
  },
  'settings.set': {
    title: 'Change a setting',
    description:
      'Changes one setting (keys and value types: settings.get): `theme.mode` light|dark, `theme.preset` a theme\'s value or name, `theme.primaryColor`, `theme.radius`, `theme.scale`, `theme.fontFamily`, `theme.colors.<light|dark>.<slot>` #rrggbb, `chat.showThinking`, `chat.showTools`, `chat.harness`. Ask Isaac first. He sees a toast "<you> changed <setting> to <value>" with Undo. Answers the previous value and a `changeId` for settings.undo.',
    params: z
      .object({ key: AgentSettingKeySchema, value: z.unknown(), scope })
      .strict()
      .superRefine((v, ctx) => {
        const r = parseSettingValue(v.key, v.value)
        if (!r.ok) ctx.addIssue({ code: 'custom', path: ['value'], message: r.message })
      }),
    side: 'renderer',
    focus: 'none',
    destructive: false,
    scoped: true,
  },
  'settings.undo': {
    title: 'Undo a setting change',
    description:
      "Puts a setting back as it was before an agent's settings.set: `changeId` from its answer, else the latest agent change not undone yet. Same as the toast's Undo.",
    params: z.object({ changeId: z.string().min(1).max(64).optional(), scope }).strict(),
    side: 'renderer',
    focus: 'none',
    destructive: false,
    scoped: true,
  },
  'connections.list': {
    title: 'List connections',
    description:
      'The services Relay reads from or signs in to (Relay Host, GitHub, Linear, Slack, Claude, ChatGPT): status, who it is signed in as, where it comes from, what uses it, whether Relay can add or remove it, and its deep link. Never any part of a secret.',
    params: Empty,
    side: 'main',
    focus: 'none',
    destructive: false,
  },
  'connections.add': {
    title: 'Add a connection',
    description:
      "Connects a service. Ask Isaac first. Linear with `secret` (a lin_api_ key he gave you) saves it to Relay's config (0600) and checks it; it is never echoed back. Anything that needs his sign-in (GitHub, Claude, ChatGPT, Linear without a key, pairing a Relay Host) answers `needs-user` with a relay:// `link` to its row in Settings > Connections and the `step` he takes there: send him the link.",
    params: z
      .object({ id: ConnectionIdSchema, secret: LinearKeySchema.optional(), scope })
      .strict()
      .refine((v) => v.secret === undefined || v.id === 'linear', {
        message: 'only linear takes a secret',
      }),
    side: 'main',
    focus: 'none',
    destructive: false,
    scoped: true,
  },
  'connections.remove': {
    title: 'Remove a connection',
    description:
      "Disconnects a service Relay manages: Linear (the key Relay saved) or GitHub (gh auth logout). Needs confirm and Isaac's approval. A key that comes from elsewhere (an env var, Eva's secrets) is not touched; the refusal says where it lives.",
    params: z.object({ id: ConnectionIdSchema, scope }).strict(),
    side: 'main',
    focus: 'none',
    destructive: true,
    scoped: true,
  },
  link: {
    title: 'Build a deep link',
    description:
      "A relay:// link to a page (`page`), a Settings section (`section`), a setting (`setting`, which points its control out), a connection's Connect step (`connection`), a Reviews item (`item`), a board (`canvas`, and a `node` on it), a Test Bench run (`experiment`, `arm`), a Studio job (`job`), a chat (`chat` session file, and a `message` in it), a web page as a page tab (`web`) or a file in the Files tab (`path`, `line`); `workspace` names the workspace a web page or file belongs to. Answers {url, label, markdown}: put `markdown` in a chat reply and it shows as a button that opens that place (desktop and iPhone). Changes nothing.",
    params: AgentLinkParamsSchema,
    side: 'main',
    focus: 'none',
    destructive: false,
  },
  'link.open': {
    title: 'Open a deep link',
    description:
      'Opens a relay:// link (from `link`, or one Isaac copied with Cmd+Shift+C) in the app: `here` in the workspace on screen, in front (default), `background` as a tab that does not come forward, `split` in a new split beside the focused pane, `tab` a new app tab.',
    params: z
      .object({
        url: z
          .string()
          .max(4096)
          .refine((u) => parseAppLink(u) !== null, { message: 'a relay:// link (see link)' }),
        target: z.enum(['here', 'background', 'split', 'tab']).optional(),
      })
      .strict(),
    side: 'renderer',
    focus: 'main',
    destructive: false,
  },
  'tour.highlight': {
    title: 'Point out a control',
    description:
      'Spotlights one control on screen (a `target` from describe: its data-tour or data-testid) and shows `caption` beside it, for a tour or to show where something is. It stays until Isaac clicks, presses Escape, the next highlight, tour.clear or `ms` (default 15 s). Changes nothing; answers where the control is. Open its page first (page.open, link.open).',
    params: z
      .object({
        target: TourTargetSchema,
        caption: z.string().trim().min(1).max(300),
        title: z.string().trim().min(1).max(80).optional(),
        /** "Step 2 of 5" under the caption. */
        step: z
          .object({ n: z.number().int().min(1), of: z.number().int().min(1) })
          .strict()
          .optional(),
        ms: z.number().int().min(1000).max(120_000).optional(),
      })
      .strict(),
    side: 'renderer',
    focus: 'none',
    destructive: false,
  },
  'tour.clear': {
    title: 'Clear the spotlight',
    description: 'Removes the tour.highlight spotlight.',
    params: Empty,
    side: 'renderer',
    focus: 'none',
    destructive: false,
  },
} as const satisfies Record<string, AgentActionSpec>

export type AgentActionId = keyof typeof agentActions
export type AgentParams<K extends AgentActionId> = z.output<(typeof agentActions)[K]['params']>
export type AgentActionsOn<S extends AgentSide> = {
  [K in AgentActionId]: (typeof agentActions)[K]['side'] extends S ? K : never
}[AgentActionId]
/** One implementation per action of a side; typecheck fails when one is missing. */
export type AgentRunners<S extends AgentSide> = {
  [K in AgentActionsOn<S>]: (params: AgentParams<K>) => unknown
}

export const AGENT_ACTION_IDS = Object.keys(agentActions) as AgentActionId[]

export function isAgentActionId(id: string): id is AgentActionId {
  return Object.hasOwn(agentActions, id)
}

export interface AgentCatalogEntry {
  id: AgentActionId
  title: string
  description: string
  side: AgentSide
  focus: AgentFocus
  destructive: boolean
  params: unknown
}

/** The catalog GET /actions serves: each action with its params as JSON Schema. */
export function agentCatalog(): AgentCatalogEntry[] {
  return AGENT_ACTION_IDS.map((id) => {
    const a: AgentActionSpec = agentActions[id]
    return {
      id,
      title: a.title,
      description: a.description,
      side: a.side,
      focus: a.focus,
      destructive: a.destructive,
      params: z.toJSONSchema(a.params, { io: 'input', unrepresentable: 'any' }),
    }
  })
}

/** What a run returns across the bridge. `queued` means it waits until Isaac stops typing. */
export const AgentResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown(), queued: z.boolean().optional() }),
  z.object({ ok: z.literal(false), code: z.string().max(64), message: z.string().max(2000) }),
])
export type AgentResult = z.output<typeof AgentResultSchema>

const RequestId = z.string().min(1).max(64)

export const agentInvoke = {
  /** The renderer's answer to an `agent.run` request. */
  'agent.reply': {
    input: z.object({ id: RequestId, result: AgentResultSchema }).strict(),
    output: z.object({}),
  },
  /** Isaac's answer to an `agent.confirm` toast. */
  'agent.confirm.reply': {
    input: z.object({ id: RequestId, approved: z.boolean() }).strict(),
    output: z.object({}),
  },
  /**
   * Isaac used the window (`input`: a key, click or scroll), or the page in front changed. Main
   * tells the Relay Host, so agents on the Mini act on the Mac he is using (remote control).
   */
  'agent.presence': {
    input: z.object({ page: z.string().max(300).nullable(), input: z.boolean() }).strict(),
    output: z.object({}),
  },
} as const

export const agentEvents = {
  /** Run a renderer action (`@state` is the renderer half of state.read). */
  'agent.run': z.object({ id: RequestId, action: z.string(), params: z.unknown() }),
  /** Ask Isaac to approve a destructive action; unanswered means no. */
  'agent.confirm': z.object({
    id: RequestId,
    title: z.string(),
    detail: z.string(),
    timeoutMs: z.number().int().positive(),
  }),
} as const
