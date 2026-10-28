import { z } from 'zod'
import { SwitchAppIdSchema, TabIdSchema } from './browser'
import { ContextScopeSchema, PinIdSchema, PinRefSchema } from './context'
import { ArtifactKind, ArtifactTabIcon, TabRule } from '@evaos/chat-core/artifacts'
import { CanvasLiveSlugSchema } from '@evaos/chat-core/canvas-live'

/**
 * Agent control: every user-reachable action an agent (Eva, Nova, any omp session) may run in the
 * app, one typed entry each. Main serves the catalog over the loopback control API
 * (main/agent-control) and runs `side: 'main'` entries itself; `side: 'renderer'` entries run in
 * the shell page (renderer/agent). A new entry here fails typecheck until its side implements it.
 *
 * `focus` names what an action replaces: `main` the main column (page, chat, tab; the panel
 * follows the page's scope), `panel` the side panel's content, `none` nothing on screen. While
 * Isaac types in a text field the action would replace (anywhere for `main`, inside the panel for
 * `panel`), it waits in a queue instead of running.
 * `destructive` actions need `confirm: true` from the agent and Isaac's approval in the app.
 *
 * Panel actions (and testbench.open) take an optional `scope`: the page or chat whose side panel
 * they act on (AgentScopeSchema). A scope that is not in front gets the change in its own panel
 * without switching pages or taking focus; Isaac sees a badge on that page's tab. A request's
 * `scope` (relay-ctl sends the caller's own) fills in for panel actions that name none, and for
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

const ArtifactItemId = z.string().min(1).max(2100)
const ArtifactTabId = z.string().min(1).max(48)
const ARTIFACTS_SCOPE =
  "Acts on the calling session's thread (an assistant's whole thread, else the chat's)."

export const agentActions = {
  'state.read': {
    title: 'Read state',
    description:
      'What is on screen: the window (focused or not), the page and app tabs, the open chat (with its unsent composer draft), the side panel and its view, browser tabs, the Files panel, and a text summary of the main column and panel.',
    params: Empty,
    side: 'main',
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
    title: 'Focus an app tab',
    description: 'Switches to an app tab by its id (state.read lists them).',
    params: z.object({ id: TabNumber }).strict(),
    side: 'renderer',
    focus: 'main',
    destructive: false,
  },
  'tab.close': {
    title: 'Close an app tab',
    description: 'Closes an app tab by its id. Chats stay in the chat list.',
    params: z.object({ id: TabNumber }).strict(),
    side: 'renderer',
    focus: 'main',
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
      "Shows a file or folder in the side panel's Files tab. A folder expands, scrolls into view and is selected in the tree; a file opens in the editor (at `line`). Paths are absolute or Eva-relative; outside the open chat's worktree the panel switches to the Eva root.",
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
      "Opens a URL (or a bare local port like `3000`) in a new tab of the side panel's browser.",
    params: z.object({ url: z.string().min(1).max(2048), scope }).strict(),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
  },
  'browser.focusTab': {
    title: 'Focus a browser tab',
    description: 'Shows a browser tab by id (state.read lists them) in the side panel.',
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
  'panel.show': {
    title: 'Show a panel tool',
    description:
      'Opens the side panel on the Browser, Files or Artifacts tab (Artifacts: what the thread holds, tickets, PRs, links, media, subagents).',
    params: z.object({ tool: z.enum(['browser', 'files', 'artifacts']), scope }).strict(),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
  },
  'panel.subagent': {
    title: "Show a subagent's transcript",
    description:
      'Opens the side panel on a subagent transcript: the chat session file and the subagent `.jsonl` (absolute paths).',
    params: z
      .object({
        session: z.string().min(1).max(4096),
        file: z.string().min(1).max(4096),
        name: z.string().min(1).max(200),
        scope,
      })
      .strict(),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
  },
  'panel.close': {
    title: 'Close the side panel',
    description: 'Closes the side panel (of `scope`, else of the page in front).',
    params: z.object({ scope }).strict(),
    side: 'renderer',
    focus: 'panel',
    destructive: false,
  },
  'testbench.open': {
    title: 'Open Test Bench',
    description:
      "Opens the Test Bench page; with `experiment` (folder under work/experiments) opens that run, and with `arm` also the arm details in the side panel. With `scope` (needs `arm`) it stays on the current page and shows only the arm details, in that scope's panel.",
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
