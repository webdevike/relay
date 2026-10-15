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
    ? ['--mode', 'rpc', '--resume', file, '--no-extensions', '--no-skills', '--no-rules', '--no-lsp', '--no-title']
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
  const list = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.models) ? data.models : []
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
  | { kind: 'percent'; value: number }
  | { kind: 'tokens'; value: number }
  | { kind: 'unavailable' }

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
    const value = (rest.slice('approvalMode:'.length).split('#')[0] ?? '').trim().replace(/^["']+|["']+$/g, '')
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
