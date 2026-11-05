import { z } from 'zod'
import { buildAppLink, parseAppLink, type AppLink } from '@evaos/chat-core/widget'

/**
 * What agents can see, change and link to in the app beyond the pane and page actions in
 * agent.ts: the page catalog (pages.list), typed settings (settings.get/set/undo), the
 * connections Relay reads from (connections.*), relay:// deep links (link) and tour targets.
 * apps/desktop/docs/agent-access.md is the coverage matrix built on these.
 */

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
  'reviews',
  'settings',
  'setup',
] as const
export type AgentFixedPage = (typeof AGENT_FIXED_PAGES)[number]

/** Settings > sections, in sidebar order (shell-core SETTINGS_SECTIONS holds the same list). */
export const AGENT_SETTINGS_SECTIONS = [
  'Theme',
  'Chat',
  'Links',
  'Notifications',
  'Connections',
  'Setup',
  'About',
  'Changelog',
] as const
export type AgentSettingsSection = (typeof AGENT_SETTINGS_SECTIONS)[number]
export const AgentSettingsSectionSchema = z.enum(AGENT_SETTINGS_SECTIONS)

/** One page as pages.list and the coverage matrix describe it. */
export interface AgentPageInfo {
  /** A page key (`settings`) or a key pattern (`workspace:<slug>`). */
  key: string
  title: string
  description: string
  /** Its deep link (a pattern for a key pattern). */
  link: string
  /** Settings only: its sections. */
  sections?: readonly AgentSettingsSection[]
  /** What an agent reads and changes there (actions and settings keys). */
  read: readonly string[]
  change: readonly string[]
}

const PANES = ['describe', 'layout.read', 'window.screenshot']

export const AGENT_PAGES: readonly AgentPageInfo[] = [
  {
    key: 'dashboard',
    title: 'Dashboard',
    description: 'Workspaces, open todos and live widgets.',
    link: 'relay://open/dashboard',
    read: PANES,
    change: ['page.open', 'shortcut.run new-todo'],
  },
  {
    key: 'assistants',
    title: 'Assistants',
    description: 'Every assistant (Nova, Astra, ...) with its thread.',
    link: 'relay://open/assistants',
    read: PANES,
    change: ['page.open'],
  },
  {
    key: 'agent:<id>',
    title: 'Assistant thread',
    description: "One assistant's whole thread and its Artifacts.",
    link: 'relay://assistant/<id>',
    read: [...PANES, 'artifacts.list'],
    change: ['page.open', 'artifacts.*'],
  },
  {
    key: 'chat',
    title: 'Chat',
    description: 'A chat (omp session) with its composer; tool panes beside it.',
    link: 'relay://open/chat',
    read: [...PANES, 'state.read'],
    change: ['chat.open', 'chat.new', 'chat.start (destructive)'],
  },
  {
    key: 'jobs',
    title: 'Jobs',
    description: 'Scheduled and running jobs.',
    link: 'relay://open/jobs',
    read: PANES,
    change: ['page.open'],
  },
  {
    key: 'test-bench',
    title: 'Test Bench',
    description: 'Experiments and their arms.',
    link: 'relay://open/test-bench?experiment=<dir>&arm=<id>',
    read: PANES,
    change: ['testbench.open'],
  },
  {
    key: 'habits',
    title: 'Habits',
    description: 'Habit gates and photos.',
    link: 'relay://open/habits',
    read: PANES,
    change: ['page.open'],
  },
  {
    key: 'meetings',
    title: 'Meetings',
    description: 'Meetings and their proposals.',
    link: 'relay://open/meetings?meeting=<id>',
    read: PANES,
    change: ['page.open'],
  },
  {
    key: 'canvas',
    title: 'Canvas',
    description: 'Boards; live canvas rooms with an agent.',
    link: 'relay://open/canvas?canvas=<slug>',
    read: PANES,
    change: ['page.open', 'canvas.live'],
  },
  {
    key: 'board:<slug>',
    title: 'Board',
    description: 'A Relay host dashboard board.',
    link: 'relay://open/board/<slug>',
    read: PANES,
    change: ['page.open'],
  },
  {
    key: 'rooms',
    title: 'Rooms',
    description: 'Group rooms with people and assistants.',
    link: 'relay://open/rooms',
    read: PANES,
    change: ['page.open'],
  },
  {
    key: 'studio',
    title: 'Studio',
    description: 'Image and video jobs on the Relay host.',
    link: 'relay://open/studio?job=<id>',
    read: [...PANES, 'studio.list'],
    change: ['studio.generate (free backends)', 'studio.open'],
  },
  {
    key: 'reviews',
    title: 'Reviews',
    description: 'Pull requests, Linear issues and Slack threads waiting on Isaac.',
    link: 'relay://open/reviews?item=<link>',
    read: PANES,
    change: ['page.open'],
  },
  {
    key: 'workspace:<slug>',
    title: 'Workspace',
    description: 'One Eva workspace.',
    link: 'relay://open/workspace/<slug>',
    read: PANES,
    change: ['page.open'],
  },
  {
    key: 'settings',
    title: 'Settings',
    description:
      'Theme (presets, colors, light or dark), Chat, Links, Connections, Setup, About, Changelog.',
    link: 'relay://open/settings/<section>?setting=<key>',
    sections: AGENT_SETTINGS_SECTIONS,
    read: [...PANES, 'settings.get', 'connections.list'],
    change: ['settings.set', 'settings.undo', 'connections.add', 'connections.remove'],
  },
  {
    key: 'setup',
    title: 'Setup',
    description: 'The first-run wizard: tools, AI sign-in, Relay Host, iPhone.',
    link: 'relay://open/setup',
    read: PANES,
    change: ['page.open'],
  },
]

// ---------------------------------------------------------------------------------------------
// Settings

/** Theme color slots per light/dark scheme (widget-runtime SemanticColors). */
export const THEME_SEMANTIC_COLORS = [
  'body',
  'border',
  'card',
  'dimmed',
  'input',
  'muted',
  'placeholder',
  'popover',
  'surface',
  'text',
] as const
export const THEME_COLOR_SCHEMES = ['light', 'dark'] as const
/** Mantine's color names, the theme editor's Primary color options. */
export const THEME_PRIMARY_COLORS = [
  'dark',
  'gray',
  'red',
  'pink',
  'grape',
  'violet',
  'indigo',
  'blue',
  'cyan',
  'teal',
  'green',
  'lime',
  'yellow',
  'orange',
] as const

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a #rrggbb color')

export interface AgentSettingSpec {
  title: string
  description: string
  section: AgentSettingsSection
  value: z.ZodType
}

type ThemeColorKey =
  `theme.colors.${(typeof THEME_COLOR_SCHEMES)[number]}.${(typeof THEME_SEMANTIC_COLORS)[number]}`

const FIXED_SETTINGS = {
  'theme.mode': {
    title: 'Appearance',
    description: 'The appearance; the theme preset keeps its own colors for each.',
    section: 'Theme',
    value: z.enum(THEME_COLOR_SCHEMES),
  },
  'theme.preset': {
    title: 'Theme',
    description:
      'The theme, by its value or name (settings.get lists them: default, ocean, forest, violet, ... and his own).',
    section: 'Theme',
    value: z.string().trim().min(1).max(200),
  },
  'theme.primaryColor': {
    title: 'Primary color',
    description: 'The accent color buttons, links and highlights use.',
    section: 'Theme',
    value: z.enum(THEME_PRIMARY_COLORS),
  },
  'theme.radius': {
    title: 'Corner radius',
    description: 'How round controls are, xs (square) to xl.',
    section: 'Theme',
    value: z.enum(['xs', 'sm', 'md', 'lg', 'xl']),
  },
  'theme.scale': {
    title: 'Scale',
    description: 'The size of everything, 0.8 to 1.4 (1 is normal).',
    section: 'Theme',
    value: z.number().min(0.8).max(1.4),
  },
  'theme.fontFamily': {
    title: 'Font',
    description: 'The body font, a CSS font-family list.',
    section: 'Theme',
    value: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[\w\s,"'-]+$/, 'a CSS font-family list'),
  },
  'chat.showThinking': {
    title: 'Show thinking',
    description: "Whether chats show the model's thinking.",
    section: 'Chat',
    value: z.boolean(),
  },
  'chat.showTools': {
    title: 'Show tool calls',
    description: 'Whether chats show tool calls.',
    section: 'Chat',
    value: z.boolean(),
  },
  'chat.harness': {
    title: 'New chats run in',
    description: 'omp or claude for new chats.',
    section: 'Chat',
    value: z.enum(['omp', 'claude']),
  },
} as const satisfies Record<string, AgentSettingSpec>

export type AgentSettingKey = keyof typeof FIXED_SETTINGS | ThemeColorKey

const settings: Record<string, AgentSettingSpec> = { ...FIXED_SETTINGS }
for (const scheme of THEME_COLOR_SCHEMES) {
  for (const slot of THEME_SEMANTIC_COLORS) {
    settings[`theme.colors.${scheme}.${slot}`] = {
      title: `${slot[0]!.toUpperCase()}${slot.slice(1)} color (${scheme})`,
      description: `The ${slot} color in ${scheme} mode, #rrggbb. Edits the current theme (unsaved until Isaac saves it).`,
      section: 'Theme',
      value: Hex,
    }
  }
}

/** Every key settings.get reads and settings.set changes, with its value's schema. */
export const agentSettings = settings as Record<AgentSettingKey, AgentSettingSpec>

export const AGENT_SETTING_KEYS = Object.keys(agentSettings) as AgentSettingKey[]

export function isAgentSettingKey(key: string): key is AgentSettingKey {
  return Object.hasOwn(agentSettings, key)
}

export const AgentSettingKeySchema = z
  .string()
  .max(100)
  .refine(isAgentSettingKey, { message: 'unknown setting; settings.get lists the keys' })

/** Checks `value` against the key's schema: the parsed value, or why it is wrong. */
export function parseSettingValue(
  key: string,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (!isAgentSettingKey(key)) {
    return { ok: false, message: `No setting ${key}; settings.get lists the keys` }
  }
  const r = agentSettings[key].value.safeParse(value)
  return r.success
    ? { ok: true, value: r.data }
    : { ok: false, message: `${key}: ${r.error.issues.map((i) => i.message).join('; ')}` }
}

/** One setting as settings.get answers it. */
export interface AgentSettingValue {
  key: AgentSettingKey
  title: string
  section: AgentSettingsSection
  value: unknown
  /** The values it takes, when they are a short list (presets, modes, colors). */
  options?: readonly string[]
  link: string
}

// ---------------------------------------------------------------------------------------------
// Connections

/** The services Relay reads from or signs in to. */
export const CONNECTION_IDS = [
  'relay-host',
  'github',
  'linear',
  'slack',
  'anthropic',
  'openai',
] as const
export const ConnectionIdSchema = z.enum(CONNECTION_IDS)
export type ConnectionId = z.infer<typeof ConnectionIdSchema>

/** How a connection is made: a paired host, a browser sign-in, a pasted key, or Claude's connector. */
export type ConnectionKind = 'host' | 'login' | 'key' | 'connector'

export const CONNECTIONS: Record<
  ConnectionId,
  { title: string; kind: ConnectionKind; usedBy: string }
> = {
  'relay-host': {
    title: 'Relay Host',
    kind: 'host',
    usedBy: 'Assistants, the iPhone, Studio and live canvas rooms',
  },
  github: { title: 'GitHub', kind: 'login', usedBy: 'Reviews, pull request status and Artifacts' },
  linear: { title: 'Linear', kind: 'key', usedBy: 'Reviews, ticket badges and Artifacts status' },
  slack: { title: 'Slack', kind: 'connector', usedBy: "Reviews (read through Claude's connector)" },
  anthropic: { title: 'Claude (Anthropic)', kind: 'login', usedBy: 'Chats and assistants' },
  openai: { title: 'ChatGPT (OpenAI)', kind: 'login', usedBy: 'Chats and assistants' },
}

export const ConnectionStatusSchema = z.enum(['connected', 'not-connected', 'unknown'])

/** One connection as connections.list answers it. Never holds a secret or any part of one. */
export const ConnectionSchema = z.object({
  id: ConnectionIdSchema,
  title: z.string(),
  kind: z.enum(['host', 'login', 'key', 'connector']),
  status: ConnectionStatusSchema,
  /** Who it is signed in as (a login, a host name), when known. */
  account: z.string().nullable(),
  /** One plain line: where it comes from, or what is missing. */
  detail: z.string(),
  usedBy: z.string(),
  /** Whether Relay can add or remove it from Settings (else `detail` says where). */
  canAdd: z.boolean(),
  canRemove: z.boolean(),
  /** Its row in Settings > Connections. */
  link: z.string(),
})
export type Connection = z.infer<typeof ConnectionSchema>

/** A Linear personal API key (Linear > Settings > Security & access). */
export const LinearKeySchema = z
  .string()
  .trim()
  .regex(/^lin_(api|oauth)_[A-Za-z0-9]{20,80}$/, 'a Linear API key (lin_api_...)')

/**
 * What adding a connection answers: done, or the step only Isaac can take (a browser sign-in, a
 * key he pastes) with the deep link to where he takes it. A device code shows for GitHub.
 */
export const ConnectResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('connected'),
    id: ConnectionIdSchema,
    account: z.string().nullable(),
  }),
  z.object({
    status: z.literal('needs-user'),
    id: ConnectionIdSchema,
    /** relay:// link to the row in Settings > Connections that does it. */
    link: z.string(),
    /** What Isaac does there, one sentence. */
    step: z.string(),
    /** A page he finishes it on (GitHub's device page), when there is one. */
    url: z.string().optional(),
    /** GitHub's one-time device code, while its sign-in waits. */
    code: z.string().optional(),
  }),
])
export type ConnectResult = z.infer<typeof ConnectResultSchema>

export const connectionsInvoke = {
  'connections.list': {
    input: z.object({}).strict(),
    output: z.object({ connections: z.array(ConnectionSchema) }),
  },
  /**
   * Isaac's Connect in Settings: saves a Linear key, or starts GitHub's browser sign-in (answers
   * its device code; `connections.changed` follows when it finishes).
   */
  'connections.connect': {
    input: z.object({ id: ConnectionIdSchema, secret: LinearKeySchema.optional() }).strict(),
    output: ConnectResultSchema,
  },
  'connections.disconnect': {
    input: z.object({ id: ConnectionIdSchema }).strict(),
    output: z.object({}),
  },
} as const

export const connectionsEvents = {
  'connections.changed': z.object({ connections: z.array(ConnectionSchema) }),
} as const

// ---------------------------------------------------------------------------------------------
// Deep links

/** A page `link` names: a fixed page, or `workspace:`/`agent:`/`board:` with an id. */
const LinkPage = z.union([
  z.enum(AGENT_FIXED_PAGES),
  z.string().regex(/^(workspace|board):[a-z0-9][a-z0-9._-]{0,199}$/),
  z.string().regex(/^agent:[a-z0-9][a-z0-9-]{0,63}$/),
])

export const AgentLinkParamsSchema = z
  .object({
    page: LinkPage.optional(),
    section: AgentSettingsSectionSchema.optional(),
    /** A setting key: its Settings section, with that control pointed out. */
    setting: AgentSettingKeySchema.optional(),
    /** A connection: Settings > Connections with its Connect step open. */
    connection: ConnectionIdSchema.optional(),
    /** Reviews: a GitHub PR, Linear issue or Slack message link. */
    item: z.string().url().max(2048).optional(),
    canvas: z.string().min(1).max(200).optional(),
    meeting: z.string().min(1).max(500).optional(),
    experiment: z.string().min(1).max(200).optional(),
    arm: z.string().min(1).max(200).optional(),
    job: z.string().min(1).max(100).optional(),
    /** A chat: its session file, and optionally a message in it. */
    chat: z.string().min(1).max(1000).optional(),
    message: z.string().min(1).max(200).optional(),
    /** A web page (http(s)) as a page tab. */
    web: z
      .string()
      .url()
      .max(2048)
      .refine((u) => /^https?:\/\//i.test(u), { message: 'an http(s) URL' })
      .optional(),
    /** A file in the Files tab (absolute or Eva-root relative), at `line`. */
    path: z.string().min(1).max(2000).optional(),
    line: z.number().int().positive().optional(),
    /** A node on a canvas board. */
    node: z.string().min(1).max(200).optional(),
    /** The workspace key a web page or file belongs to. */
    workspace: z.string().min(1).max(1000).optional(),
    /** The link's text in chat; default: where it goes ("Settings › Connections"). */
    label: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.page !== undefined ||
      v.setting !== undefined ||
      v.connection !== undefined ||
      v.chat !== undefined ||
      v.web !== undefined ||
      v.path !== undefined,
    { message: 'give page, setting, connection, chat, web or path' },
  )
export type AgentLinkParams = z.output<typeof AgentLinkParamsSchema>

const PAGE_TITLE: Record<string, string> = Object.fromEntries(
  AGENT_PAGES.filter((p) => !p.key.includes('<')).map((p) => [p.key, p.title]),
)

/** Fails with a stable code, as agent runners do. */
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

/**
 * The relay:// link for a place in the app, its label and a Markdown link for chat. Throws
 * `invalid-params` for parts that don't belong together (an item outside Reviews).
 */
export function appLinkFor(p: AgentLinkParams): { url: string; label: string; markdown: string } {
  const section: AgentSettingsSection | undefined =
    p.connection !== undefined
      ? 'Connections'
      : p.setting !== undefined
        ? agentSettings[p.setting as AgentSettingKey].section
        : p.section
  const tool =
    p.web !== undefined ? 'web' : p.path !== undefined ? 'files' : p.chat !== undefined ? 'chat' : null
  if (tool !== null && p.page !== undefined && p.page !== tool) {
    fail('invalid-params', 'chat, web and path name their own page')
  }
  const page = tool ?? p.page ?? 'settings'
  if (section !== undefined && page !== 'settings') {
    fail('invalid-params', 'section, setting and connection belong to the settings page')
  }
  const only = (key: string, pages: string[]): void => {
    if (p[key as keyof AgentLinkParams] !== undefined && !pages.includes(page)) {
      fail('invalid-params', `${key} belongs to ${pages.join(' or ')}`)
    }
  }
  only('item', ['reviews'])
  only('canvas', ['canvas'])
  only('meeting', ['meetings'])
  only('experiment', ['test-bench'])
  only('arm', ['test-bench'])
  only('job', ['studio'])
  only('message', ['chat'])
  only('line', ['files'])
  only('node', ['canvas'])
  only('workspace', ['web', 'files'])
  if ([p.web, p.path, p.chat].filter((v) => v !== undefined).length > 1)
    fail('invalid-params', 'give one of chat, web and path')
  if (p.arm !== undefined && p.experiment === undefined)
    fail('invalid-params', 'arm needs experiment')

  let link: AppLink
  const colon = page.indexOf(':')
  if (colon > 0) {
    const kind = page.slice(0, colon)
    const id = page.slice(colon + 1)
    link = kind === 'agent' ? { kind: 'assistant', id } : { kind: 'open', page: kind, sub: id }
  } else {
    const params: Extract<AppLink, { kind: 'open' }>['params'] = {}
    if (p.item !== undefined) params.item = p.item
    if (p.setting !== undefined) params.setting = p.setting
    if (p.connection !== undefined) params.connect = p.connection
    if (p.canvas !== undefined) params.canvas = p.canvas
    if (p.meeting !== undefined) params.meeting = p.meeting
    if (p.experiment !== undefined) params.experiment = p.experiment
    if (p.arm !== undefined) params.arm = p.arm
    if (p.job !== undefined) params.job = p.job
    if (p.chat !== undefined) params.chat = p.chat
    if (p.message !== undefined) params.message = p.message
    if (p.web !== undefined) params.url = p.web
    if (p.path !== undefined) params.path = p.path
    if (p.line !== undefined) params.line = String(p.line)
    if (p.node !== undefined) params.node = p.node
    if (p.workspace !== undefined) params.ws = p.workspace
    link = {
      kind: 'open',
      page,
      ...(section === undefined ? {} : { sub: section.toLowerCase() }),
      ...(Object.keys(params).length > 0 ? { params } : {}),
    }
  }
  const url = buildAppLink(link)
  if (parseAppLink(url) === null) fail('invalid-params', `Cannot link to ${url}`)
  const text = p.label ?? appLinkLabel(link)
  return { url, label: text, markdown: `[${text.replace(/[[\]]/g, '')}](${url})` }
}

/** Where a relay:// link goes, in words: "Settings › Connections › GitHub", "Workspace ecard". */
export function appLinkLabel(link: AppLink): string {
  if (link.kind === 'assistant') return `Assistant ${link.id}`
  if (link.page === 'workspace' || link.page === 'board') {
    return `${link.page === 'board' ? 'Board' : 'Workspace'} ${link.sub ?? ''}`.trim()
  }
  const { url, path } = link.params ?? {}
  if (link.page === 'web' && url !== undefined) {
    // The contract has no DOM or Node globals: the authority part of the URL, without user info.
    const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#]+)/i.exec(url)?.[1]
    return host ?? url
  }
  if (link.page === 'files' && path !== undefined) return path.split('/').pop() || path
  const parts = [PAGE_TITLE[link.page] ?? link.page]
  const section = link.page === 'settings' ? settingsSectionOf(link.sub) : null
  if (section !== null) parts.push(section)
  const connect = ConnectionIdSchema.safeParse(link.params?.connect)
  if (connect.success) parts.push(CONNECTIONS[connect.data].title)
  const setting = link.params?.setting
  if (setting !== undefined && isAgentSettingKey(setting)) parts.push(agentSettings[setting].title)
  return parts.join(' › ')
}

/** The settings section a `relay://open/settings/<sub>` names, or null. */
export function settingsSectionOf(sub: string | undefined): AgentSettingsSection | null {
  return AGENT_SETTINGS_SECTIONS.find((s) => s.toLowerCase() === sub) ?? null
}

// ---------------------------------------------------------------------------------------------
// Tour and the OS deep-link handler

/** A control a tour points at: its `data-tour` or `data-testid` (describe lists those on screen). */
export const TourTargetSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9:_./-]+$/, 'a data-tour or data-testid value')

export const deepLinkInvoke = {
  /** relay:// links macOS handed the app before the page listened (`app.openLink` after that). */
  'app.pendingLinks': {
    input: z.object({}).strict(),
    output: z.object({ urls: z.array(z.string().max(4096)) }),
  },
} as const

export const deepLinkEvents = {
  /** A relay:// link clicked outside the app (a browser, Mail, a terminal): open it in front. */
  'app.openLink': z.object({ url: z.string().max(4096) }),
} as const
