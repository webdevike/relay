// Launch argv, model catalog, context ring math. Ported from Rust chat.rs (Launch::args,
// ModelInfo::from_json, menu_order, configured_approval) and chat_ops.rs (rename_session).
//
// For 04-18 (Assumption A3, confirmed in chat.rs ModelSender::set_model): switching model on a
// live session sends { type: 'set_model', provider, modelId }. Thinking and fast mode use
// { type: 'set_thinking_level', level } and { type: 'set_fast_mode', enabled } (see
// chat.rs ~2228). Argv here is flags only; the transport adds --mode/--resume. Callers spawn
// without a shell.

export type Approval = 'yolo' | 'write' | 'always-ask'
export type Profile = 'personal' | 'work'
export type Harness = 'omp' | 'claude'

export const APPROVAL_LABEL: Record<Approval, string> = {
  yolo: 'Full access',
  write: 'Ask before commands',
  'always-ask': 'Ask before edits',
}

export interface Launch {
  model?: readonly [string, string]
  thinking?: string
  approval: Approval
  profile: Profile | null
}

function flags(l: Launch, withProfile: boolean): string[] {
  const args: string[] = []
  if (withProfile && l.profile !== null) args.push('--profile', l.profile)
  if (l.model !== undefined) args.push('--model', `${l.model[0]}/${l.model[1]}`)
  if (l.thinking !== undefined) args.push('--thinking', l.thinking)
  args.push('--approval-mode', l.approval)
  return args
}

/** omp flags, in Rust order: profile, model, thinking, approval. */
export function ompArgs(l: Launch): string[] {
  return flags(l, true)
}

/**
 * Claude bridge flags: the same omp flags (the bridge maps model alias, thinking to effort and
 * approval to permission mode itself); the omp account profile does not apply.
 */
export function claudeArgs(l: Launch): string[] {
  return flags(l, false)
}

/** Full argv (after the binary) for the short resume that renames a session. */
export function renameArgs(h: Harness, file: string): string[] {
  return h === 'omp'
    ? [
        '--mode',
        'rpc',
        '--resume',
        file,
        '--no-extensions',
        '--no-skills',
        '--no-rules',
        '--no-lsp',
        '--no-title',
      ]
    : ['--rpc', '--no-relay', '--resume', file]
}

export interface ModelInfo {
  provider: string
  id: string
  name: string
  contextWindow: number | null
  images: boolean
  levels: string[]
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Models from omp's catalog (`get_available_models` data, or a bare array). Levels start with
 * `off` and exist only for reasoning models with efforts.
 */
export function parseModels(data: unknown): ModelInfo[] {
  const list = Array.isArray(data)
    ? data
    : isObj(data) && Array.isArray(data.models)
      ? data.models
      : []
  const out: ModelInfo[] = []
  for (const m of list as unknown[]) {
    if (!isObj(m) || typeof m.provider !== 'string' || typeof m.id !== 'string') continue
    const thinking = isObj(m.thinking) ? m.thinking : {}
    const efforts = (Array.isArray(thinking.efforts) ? thinking.efforts : []).filter(
      (e): e is string => typeof e === 'string',
    )
    out.push({
      provider: m.provider,
      id: m.id,
      name: typeof m.name === 'string' ? m.name : m.id,
      contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : null,
      images: Array.isArray(m.input) && m.input.includes('image'),
      levels: m.reasoning === true && efforts.length > 0 ? ['off', ...efforts] : [],
    })
  }
  return out
}

/** One `/` menu entry (native chat.rs SlashCommand). */
export interface SlashCommand {
  name: string
  description: string
  /** Argument hint, e.g. `[focus instructions]`. */
  hint: string | null
  /** Second-word choices (`/security scan`), offered once the name and a space are typed. */
  subcommands: SlashCommand[]
}

function parseCommand(c: unknown): SlashCommand | null {
  if (!isObj(c) || typeof c.name !== 'string') return null
  const input = isObj(c.input) ? c.input : {}
  const hint =
    typeof input.hint === 'string' ? input.hint : typeof c.hint === 'string' ? c.hint : null
  const description =
    typeof c.description === 'string' ? c.description.replace(/\s+/g, ' ').trim() : ''
  return {
    name: c.name,
    description: description.length > 200 ? `${description.slice(0, 199)}…` : description,
    hint,
    subcommands: (Array.isArray(c.subcommands) ? c.subcommands : [])
      .map(parseCommand)
      .filter((s): s is SlashCommand => s !== null),
  }
}

const sub = (name: string, description: string, hint: string | null = null): SlashCommand => ({
  name,
  description,
  hint,
  subcommands: [],
})

/** omp's RPC `prompt` does not run `/goal`, so the menu offers this one (native slash_commands). */
export const GOAL_COMMAND: SlashCommand = {
  ...sub(
    'goal',
    "Set, pause, resume, or drop this session's goal",
    '[set <objective>|pause|resume|drop|status]',
  ),
  subcommands: [
    sub('set', 'Start working toward an objective', '<objective>'),
    sub('status', 'Show the current goal'),
    sub('pause', 'Pause the active goal'),
    sub('resume', 'Resume a paused goal'),
    sub('drop', 'Drop the goal'),
  ],
}

/**
 * omp's `get_available_commands` data (or a bare array) in menu order: the goal command, omp's
 * builtins, other commands, then skills. Order within each group is omp's.
 */
export function parseCommands(data: unknown): SlashCommand[] {
  const list = Array.isArray(data)
    ? data
    : isObj(data) && Array.isArray(data.commands)
      ? data.commands
      : []
  const ranked: Array<{ rank: number; command: SlashCommand }> = []
  for (const raw of list as unknown[]) {
    const command = parseCommand(raw)
    if (!command || command.name === 'goal') continue
    const source = isObj(raw) ? raw.source : undefined
    const skill = source === 'skill' || command.name.startsWith('skill:')
    ranked.push({ rank: source === 'builtin' ? 0 : skill ? 2 : 1, command })
  }
  ranked.sort((a, b) => a.rank - b.rank)
  return [GOAL_COMMAND, ...ranked.map((r) => r.command)]
}

export type GoalOp = 'get' | 'create' | 'pause' | 'resume' | 'drop'
export type GoalRequest = { type: 'goal'; op: GoalOp; objective?: string }

/**
 * The RPC `goal` command a `/goal` prompt stands for, else null (native chat.rs goal_command):
 * bare `/goal`, `status` or `get` read it; `pause`, `resume`, `drop` (or `clear`) act on it;
 * `set <objective>` or any other text creates one.
 */
export function goalCommand(text: string): GoalRequest | null {
  const t = text.trim()
  if (!t.startsWith('/goal')) return null
  const after = t.slice('/goal'.length)
  if (after !== '' && !/^\s/.test(after)) return null
  const rest = after.trim()
  const space = rest.search(/\s/)
  const word = space < 0 ? rest : rest.slice(0, space)
  const tail = space < 0 ? '' : rest.slice(space).trim()
  if (tail === '') {
    if (word === '' || word === 'status' || word === 'get') return { type: 'goal', op: 'get' }
    if (word === 'pause' || word === 'resume' || word === 'drop') return { type: 'goal', op: word }
    if (word === 'clear') return { type: 'goal', op: 'drop' }
  }
  if ((word === 'set' || word === 'create') && tail !== '')
    return { type: 'goal', op: 'create', objective: tail }
  return { type: 'goal', op: 'create', objective: rest }
}

/** A `/handoff` prompt, which generates in the background until omp's `command_output`. */
export function isHandoff(text: string): boolean {
  return text.trim() === '/handoff' || text.trimStart().startsWith('/handoff ')
}

/**
 * Menu rows for the composer's text, and the text they complete after: `/` and a partial name,
 * or `/command ` and a partial subcommand once that command has some. Prefix matches first,
 * then names containing the text (native chat_view.rs slash_matches).
 */
export function slashMatches(
  commands: readonly SlashCommand[],
  text: string,
): { prefix: string; hits: SlashCommand[] } {
  const none = { prefix: '', hits: [] }
  const lower = text.toLowerCase()
  if (!lower.startsWith('/')) return none
  const rest = lower.slice(1)
  const space = rest.indexOf(' ')
  let prefix = '/'
  let list = commands
  let query = rest
  if (space >= 0) {
    const name = rest.slice(0, space)
    const command = commands.find((c) => c.name.toLowerCase() === name)
    if (!command) return none
    prefix = `/${command.name} `
    list = command.subcommands
    query = rest.slice(space + 1)
  }
  if (/\s/.test(query)) return none
  const hits = list.filter((c) => c.name.toLowerCase().includes(query))
  hits.sort(
    (a, b) =>
      Number(!a.name.toLowerCase().startsWith(query)) -
      Number(!b.name.toLowerCase().startsWith(query)),
  )
  return { prefix, hits }
}

/** Newest first, one row per provider+name, keeping the shortest id (drops dated aliases). */
export function foldModels(models: readonly ModelInfo[]): ModelInfo[] {
  const out: ModelInfo[] = []
  for (const model of [...models].reverse()) {
    const at = out.findIndex((k) => k.provider === model.provider && k.name === model.name)
    if (at < 0) out.push(model)
    else if (model.id.length < (out[at] as ModelInfo).id.length) out[at] = model
  }
  return out
}

export type ContextReading =
  { kind: 'percent'; value: number } | { kind: 'tokens'; value: number } | { kind: 'unavailable' }

export function contextPercent(tokens: number | null, window: number | null): ContextReading {
  if (tokens === null) return { kind: 'unavailable' }
  if (window === null || window <= 0) return { kind: 'tokens', value: tokens }
  return { kind: 'percent', value: (tokens / window) * 100 }
}

export const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

const APPROVALS: readonly Approval[] = ['yolo', 'write', 'always-ask']

function approvalFrom(config: string | null): Approval | null {
  if (config === null) return null
  for (const line of config.split('\n')) {
    const rest = line.trim()
    if (!rest.startsWith('approvalMode:')) continue
    const value = (rest.slice('approvalMode:'.length).split('#')[0] ?? '')
      .trim()
      .replace(/^["']+|["']+$/g, '')
    const hit = APPROVALS.find((a) => a === value)
    if (hit !== undefined) return hit
  }
  return null
}

/**
 * omp's `tools.approvalMode` from the project `.omp/config.yml` text, else the global one, else
 * yolo. Matches Rust's line scan for `approvalMode:` (no YAML dependency in chat-core).
 */
export function readApproval(projectConfig: string | null, globalConfig: string | null): Approval {
  return approvalFrom(projectConfig) ?? approvalFrom(globalConfig) ?? 'yolo'
}

const LEVEL_KEY = 'defaultThinkingLevel:'

function thinkingFrom(config: string | null): string | null {
  if (config === null) return null
  for (const line of config.split('\n')) {
    // A top-level key: indented lines belong to some other section.
    if (!line.startsWith(LEVEL_KEY)) continue
    const value = (line.slice(LEVEL_KEY.length).split('#')[0] ?? '')
      .trim()
      .replace(/^["']+|["']+$/g, '')
    if (/^[a-z]+$/.test(value)) return value
  }
  return null
}

/**
 * omp's `defaultThinkingLevel` from the project `.omp/config.yml` text, else the global one, else
 * null (omp's own default). The level a new chat gets; the model picker resets to it.
 */
export function readThinking(
  projectConfig: string | null,
  globalConfig: string | null,
): string | null {
  return thinkingFrom(projectConfig) ?? thinkingFrom(globalConfig)
}
