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
  [
    'Eva',
    ['eva', 'eren', 'elysia', 'omp', 'subagent', 'subagents', 'skill', 'journal', 'harness'],
  ],
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
