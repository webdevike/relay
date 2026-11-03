/**
 * Workspaces the chat list groups by, in match order (EvaOS before Eva), each with the title
 * words or phrases that place a chat in it. Verbatim from the Rust app's chat.rs.
 */
export const WORKSPACES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['eCard', ['ecard', 'ecs', 'eng', 'ecardsystems', 'client api', 'reports app', 'linear']],
  ['EvaOS', ['evaos', 'eva os', 'gpui']],
  ['Relay', ['relay', 'herdr', 'catch the stars', 'airplay']],
  ['Texo', ['texo']],
  ['GoodOps', ['goodops', 'goodword']],
  ['Flo', ['flo', 'flodoc']],
  ['OpenFlight', ['openflight', 'launch monitor', 'golf']],
  ['Bambee', ['bambee']],
  ['Hexagon', ['hexagon', 'ponder']],
  ['Eva', ['eva', 'eren', 'elysia', 'omp', 'subagent', 'subagents', 'skill', 'journal', 'harness']],
]

/** The group for chats no workspace claims. */
export const OTHER_WORKSPACE = 'Other'

/**
 * The workspace a chat title belongs to: the first whose word or phrase appears in it as whole
 * words, ignoring case and punctuation ("ENG-5533" matches "eng").
 */
export function workspaceOf(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
  const padded = ` ${words} `
  for (const [name, keys] of WORKSPACES) {
    if (keys.some((key) => padded.includes(` ${key} `))) return name
  }
  return OTHER_WORKSPACE
}

/** Every workspace group's name, Other last. */
export function workspaceNames(): string[] {
  return [...WORKSPACES.map(([name]) => name), OTHER_WORKSPACE]
}

/**
 * Tool-call paths that name the project a chat worked in when its title does not. More specific
 * projects precede Eva, whose checkout holds all of these worktrees. Verbatim from chat.rs.
 */
export const WORK_PATHS: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    'eCard',
    [
      'ecardsystems/',
      'ecard-repos/',
      'react-client-reports-app',
      'node-client-api-service',
      'node-libraries-internal',
      'platform-db-flyway',
      'ecard-platform',
      'work/items/eng-',
    ],
  ],
  ['EvaOS', ['apps/evaos', 'work/evaos-']],
  ['Relay', ['work/relay', 'apps/mobile']],
  ['GoodOps', ['work/goodops', 'goodopshq/']],
  ['Texo', ['work/texo']],
  ['Flo', ['work/flo', 'flodoc']],
  ['OpenFlight', ['work/openflight', 'launch-monitor']],
]

/**
 * The workspace one raw session line points at: only assistant lines count (every session's boot
 * message lists projects, which would classify every chat), lowercased, first WORK_PATHS match.
 */
export function workspaceOfLine(line: string): string | null {
  if (!line.includes('"role":"assistant"') && !line.includes('"type":"assistant"')) return null
  const lower = line.toLowerCase()
  for (const [name, markers] of WORK_PATHS) {
    if (markers.some((m) => lower.includes(m))) return name
  }
  return null
}

/** The workspace a session's assistant turns worked in: the first line naming one (native work_workspace). */
export function workWorkspace(lines: Iterable<string>): string | null {
  for (const line of lines) {
    const name = workspaceOfLine(line)
    if (name !== null) return name
  }
  return null
}
