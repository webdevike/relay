import { z } from 'zod'
import { SwitchAppIdSchema, TabIdSchema } from './browser'
import { ContextScopeSchema, PinIdSchema, PinRefSchema } from './context'
import { ArtifactKind, ArtifactTabIcon, TabRule } from '@evaos/chat-core/artifacts'
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
 * The window is a tiling of panes (shell-core tiling.ts): the chat pane holds the app tabs, tool
 * panes hold tool tabs (browser, files, artifacts, transcripts, arm details, pages).
 * `layout.read` shows the tree; `pane.*` and `tab.*` change it.
 *
 * Content actions (files.open, browser.*, tab.open, testbench.open with an arm) take an optional
 * `scope`: the page or chat whose tool tabs they act on (AgentScopeSchema). A scope that is not in
 * front gets the change for when Isaac opens it, without switching pages or taking focus; he sees
 * a badge on that page's tab. A request's `scope` (relay-ctl sends the caller's own) fills in for
 * `panel` actions that name none (not `unscoped` ones, which lay out the whole window), and for
 * `scoped` actions (artifacts.*), which act on the caller's own thread.
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
  /** A `panel` action that lays out the whole window: the request's scope does not apply. */
  unscoped?: boolean
}

/** Top-level pages (shell-core FixedPage); `workspace:`, `agent:` and `board:` keys open details. */
export const AGENT_FIXED_PAGES = [
  'dashboard',
  'assistants',
  'chat',
  'jobs',
  'test-bench',
  'habits',
  'meetings',
  'canvas',
  'rooms',
  'studio',
  'settings',
] as const

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

/** A pane id from layout.read (`chat` is the chat pane). */
const PaneId = z.string().min(1).max(64)
/** A tool tab's id from layout.read (`browser`, `files`, `subagent:<file>`, `page:test-bench`...). */
const PaneTabId = z.string().min(1).max(4200)
const Side = z.enum(['right', 'left', 'down', 'up'])
const Share = z.number().gt(0).lt(1)

const PageTabArgs = z
  .object({
    page: z.union([
      z.enum(AGENT_FIXED_PAGES).exclude(['chat']),
      z
        .string()
        .max(300)
        .regex(/^(workspace|board):.+$/),
    ]),
    settingsSection: z.enum(['Theme', 'Chat', 'About']).optional(),
    canvas: z.string().max(200).optional(),
    meeting: z.string().max(500).optional(),
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
      kind: z.literal('artifacts'),
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
      'What is on screen: the window (focused or not), the page and app tabs, the open chat (with its unsent composer draft), the pane layout (as layout.read), browser tabs, the Files tab, and a text summary of the chat pane and each tool pane on screen.',
    params: Empty,
    side: 'main',
    focus: 'none',
    destructive: false,
  },
  'layout.read': {
    title: 'Read the pane layout',
    description:
      "The window's split tree: each split (row = side by side, column = stacked) with its children's shares, each pane with its id, tabs (id, kind, title, args), the tab in front, its px rect and whether it is on screen; the focused pane and the zoomed one. Pane `chat` holds the app tabs (chats and pages); tool panes hold the rest.",
    params: Empty,
    side: 'renderer',
    focus: 'none',
    destructive: false,
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
      'Opens a page in the current app tab (or a new one): a top-level page slug, or `workspace:<slug>`, `agent:<id>`, `board:<slug>`.',
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
        settingsSection: z.enum(['Theme', 'Chat', 'About']).optional(),
        canvas: z.string().max(200).optional(),
        meeting: z.string().max(500).optional(),
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
      'Closes an app tab by its number (chats stay in the chat list) or a tool tab by its id (a pane left empty closes; the browser keeps its pages and Files its open files).',
    params: z.object({ id: z.union([TabNumber, PaneTabId]) }).strict(),
    side: 'renderer',
    focus: 'main',
    destructive: false,
  },
  'tab.open': {
    title: 'Open a tool tab',
    description:
      'Shows a tool tab: `browser` (args.url also opens that page), `files` (args.path shows a file or folder, at args.line), `artifacts`, `subagent` (args: session file, subagent .jsonl, name), `experiment-arm` (args: experiment, arm) or `page` (args.page: test-bench, canvas with args.canvas, studio, jobs, a workspace:<slug>...; not chats). Already open: it comes to the front (moved to `pane` when one is named). Else it opens in `pane`, the focused or last tool pane, or a new pane right of the chat. Answers the pane and tab ids.',
    params: z
      .object({
        kind: z.enum(['browser', 'files', 'artifacts', 'subagent', 'experiment-arm', 'page']),
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
      "Splits `pane` (default: the focused one; a split id from layout.read puts the new pane beside that whole group) toward `dir` with a new pane showing `tab`: a tool tab id (moved there) or `{kind, args}` as tab.open takes it. Without `tab`, the pane's tab in front moves over when it has others, else the first tool not open yet. `size` is the new pane's share (0 to 1, default half). Answers the new pane id and the layout.",
    params: z
      .object({
        pane: PaneId.optional(),
        dir: Side,
        tab: z.union([PaneTabId, PaneTabSpecSchema]).optional(),
        size: Share.optional(),
      })
      .strict(),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
    unscoped: true,
  },
  'pane.close': {
    title: 'Close a pane',
    description:
      'Closes a tool pane and its tabs (the browser keeps its pages, Files its open files). The chat pane never closes; to hide every tool pane, pane.zoom the chat pane.',
    params: z.object({ pane: PaneId }).strict(),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
    unscoped: true,
  },
  'pane.move': {
    title: 'Move a tab to a pane',
    description:
      'Moves tool tab `tab` (its id) into tool pane `toPane` at `index` (default after the tab in front). A pane left empty closes.',
    params: z
      .object({ tab: PaneTabId, toPane: PaneId, index: z.number().int().min(0).optional() })
      .strict(),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
    unscoped: true,
  },
  'pane.resize': {
    title: 'Resize a pane',
    description:
      "Sets a pane's (or split's) size within its parent split: `size` as a share (0 to 1) or `px` along the split's direction. Its siblings keep their proportions; the chat pane keeps at least 480px wide and a tool pane 240px.",
    params: z
      .object({ pane: PaneId, size: Share.optional(), px: z.number().int().min(1).optional() })
      .strict()
      .refine((v) => (v.size === undefined) !== (v.px === undefined), {
        message: 'give size or px',
      }),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
    unscoped: true,
  },
  'pane.focus': {
    title: 'Focus a pane',
    description:
      "Makes `pane`, or the pane next to the focused one toward `dir`, the focused pane: new tabs and pane shortcuts go there. Never moves Isaac's keyboard focus.",
    params: z
      .object({ pane: PaneId.optional(), dir: Side.optional() })
      .strict()
      .refine((v) => (v.pane === undefined) !== (v.dir === undefined), {
        message: 'give pane or dir',
      }),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
    unscoped: true,
  },
  'pane.zoom': {
    title: 'Maximize a pane',
    description:
      'Maximizes `pane` (default: the focused one) over the others, or with `on: false` shows every pane again; without `on` it toggles. Zooming the chat pane hides the tool panes (the panel toggle, Cmd+Shift+B).',
    params: z.object({ pane: PaneId.optional(), on: z.boolean().optional() }).strict(),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
    unscoped: true,
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
    title: 'Open a browser tab',
    description:
      'Opens a URL (or a bare local port like `3000`) in a new tab of the browser, bringing the Browser tool tab to the front.',
    params: z.object({ url: z.string().min(1).max(2048), scope }).strict(),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
  },
  'browser.focusTab': {
    title: 'Focus a browser tab',
    description: 'Shows a browser tab by id (state.read lists them) in the Browser tool tab.',
    params: z.object({ tabId: TabIdSchema, scope }).strict(),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
  },
  'browser.closeTab': {
    title: 'Close a browser tab',
    description: 'Closes a browser tab by id.',
    params: z.object({ tabId: TabIdSchema, scope }).strict(),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
  },
  'ecard.switch': {
    title: 'Switch the eCard app',
    description:
      "Lists the local eCard app switch's apps (active = the browser tab in front's app); with `id`, points only that tab at the app and reloads it. Other tabs keep their own apps.",
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
      "Queues one free Studio job on the Relay host as the agent (origin `agent`) and answers `{job}` (id, state, prompt, backend, progress, eta, outputs). `mode` defaults to the backend's, else image. `backend` defaults to `ltx` (local video) for video, `codex-image` for image, `codex-edit` when `refs` are given. `aspect` defaults to 16:9 for video and 1:1 for image; `resolution` (an id studio.list shows per backend) to the first the backend offers for that aspect; `seconds` (video) to its first allowed length. `frames` ({start, mid, end}) and `refs` take asset ids from studio.list outputs. A paid backend (higgsfield) is refused: open it as a draft with studio.open so Isaac sees the cost and confirms it himself. `open: true` also shows the job in the Studio tool tab of the calling scope (never takes focus). Poll studio.list for progress.",
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
