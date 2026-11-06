import type { SlashCommand } from '@evaos/chat-core/launch'
import type { ComputerMode } from '../../../main/computer/command'

export type { ComputerMode }

/** What a row of the `@` menu stands for. */
export type AtItem =
  | { kind: 'computer-menu' }
  | { kind: 'computer'; mode: ComputerMode }
  | { kind: 'skill'; command: string }
  | { kind: 'back' }

/** The word that names a mode in the sub-list and on the chip. */
export const MODE_WORD: Record<ComputerMode, string> = {
  headless: 'background',
  live: 'live',
  walk: 'walk',
}
const MODE_CHILD_NOTE: Record<ComputerMode, string> = {
  headless: 'Works behind your apps',
  live: 'Visible cursor',
  walk: 'Walk me through it',
}
const MODES: ComputerMode[] = ['headless', 'live', 'walk']

export interface AtRow {
  key: string
  title: string
  description: string
  section?: string
  item: AtItem
  /** Opens a sub-list (Computer's modes) instead of picking. */
  children?: true
}

/** The `@` menu's levels: the top list, or one parent's children (Computer's modes). */
export type AtLevel = 'top' | 'computer'

export const COMPUTER_ROW: AtRow = {
  key: 'computer',
  title: 'Computer',
  description: 'Control Mac apps on the Mini',
  section: 'Plugins',
  item: { kind: 'computer-menu' },
  children: true,
}

/**
 * `@` menu rows for the typed word at one level. Top: Computer (opens its modes), then skills (omp's
 * `skill:` commands). Inside Computer: a back row, then Background, Live and Walk.
 */
export function atRows(
  commands: readonly SlashCommand[] | null,
  query: string,
  level: AtLevel = 'top',
): AtRow[] {
  const q = query.toLowerCase()
  if (level === 'computer') {
    const modes: AtRow[] = MODES.filter((m) => MODE_WORD[m].startsWith(q)).map((m) => ({
      key: `computer:${m}`,
      title: MODE_WORD[m][0]!.toUpperCase() + MODE_WORD[m].slice(1),
      description: MODE_CHILD_NOTE[m],
      item: { kind: 'computer', mode: m },
    }))
    return [
      { key: 'back', title: 'Computer', description: 'Back', item: { kind: 'back' } },
      ...modes,
    ]
  }
  const rows: AtRow[] = 'computer'.startsWith(q) ? [COMPUTER_ROW] : []
  const skills = (commands ?? [])
    .filter((c) => c.name.startsWith('skill:'))
    .map((c) => ({ c, bare: c.name.slice('skill:'.length).toLowerCase() }))
    .filter((s) => s.bare.includes(q))
    .sort((a, b) => Number(!a.bare.startsWith(q)) - Number(!b.bare.startsWith(q)))
  for (const { c } of skills) {
    rows.push({
      key: c.name,
      title: c.name.slice('skill:'.length),
      description: c.description,
      section: 'Skills',
      item: { kind: 'skill', command: c.name },
    })
  }
  return rows
}

/** The text sent for a draft with a Computer chip: the same `@computer` text the parser takes. */
export function withChip(mode: ComputerMode | null, text: string): string {
  if (mode === null) return text
  return `@computer ${MODE_WORD[mode]} ${text}`
}

/** A saved draft back into chip and text (`withChip`'s inverse; plain text has no chip). */
export function splitChip(saved: string): { mode: ComputerMode | null; text: string } {
  const m = /^@computer (background|live|walk) /.exec(saved)
  if (!m) return { mode: null, text: saved }
  return {
    mode: m[1] === 'background' ? 'headless' : (m[1] as ComputerMode),
    text: saved.slice(m[0].length),
  }
}

/** The `@word` the caret ends, when the `@` starts the text or follows whitespace (skills have `-` and `:`). */
export function atQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const head = text.slice(0, caret)
  const m = /(^|\s)@([\w:-]*)$/.exec(head)
  if (!m) return null
  return { start: head.length - m[2]!.length - 1, query: m[2]! }
}
