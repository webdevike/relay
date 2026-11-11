// The one `@` menu every composer shows (the chat's and a room's; Canvas and doc comments take
// their agents from `agentsOf` too): Agents (who is here first, then the other registry assistants)
// and Actions (Computer with its modes, then omp's skills). Picking an agent puts `@Name ` in the
// text, drawn as a chip (MentionBackdrop); Computer becomes the chip in front of the text.
import type { SlashCommand } from '@evaos/chat-core/launch'
import type { ChatRoomMember } from '@evaos/contract'
import type { Mentionable } from '@relay/canvas-live/mentions'
import type { ComputerMode } from '../../../main/computer/command'

export type { ComputerMode }

/** What a row of the `@` menu stands for. */
export type AtItem =
  | { kind: 'agent'; id: string; name: string }
  | { kind: 'computer-menu' }
  | { kind: 'computer'; mode: ComputerMode }
  | { kind: 'skill'; command: string }
  | { kind: 'back' }

/** An agent the menu offers: its id, its name, the grey note beside it, its registry id for the face. */
export interface AtAgent extends Mentionable {
  note: string
  /** The registry assistant behind it; absent for a room's custom agent. */
  assistant?: string
}

/** Registry assistants as mention candidates: id, title (what an `@name` matches) and what it covers. */
export function agentsOf(
  assistants: readonly { id: string; title: string; scope: string }[],
): Mentionable[] {
  return assistants.map((a) => ({
    id: a.id,
    name: a.title,
    ...(a.scope === '' ? {} : { hint: a.scope }),
  }))
}

/** A 1:1 chat's agents: its own assistant first ("in this chat"), then the others by what they cover. */
export function chatAgentsAt(
  assistants: readonly { id: string; title: string; scope: string }[],
  current: string | null,
): AtAgent[] {
  const own = assistants.filter((a) => a.id === current)
  const rest = assistants.filter((a) => a.id !== current)
  return [
    ...own.map((a) => ({ id: a.id, name: a.title, note: 'in this chat', assistant: a.id })),
    ...rest.map((a) => ({
      id: a.id,
      name: a.title,
      note: a.scope || 'Assistant',
      assistant: a.id,
    })),
  ]
}

/**
 * A room's agents: its members first ("in this room"), then the registry assistants who are not
 * in it, who join as guests when mentioned.
 */
export function roomAgentsAt(
  members: readonly ChatRoomMember[],
  assistants: readonly { id: string; title: string; scope: string }[],
): AtAgent[] {
  const first = (name: string): string => name.toLowerCase().split(/\s+/)[0]!
  const taken = new Set(members.map((m) => first(m.name)))
  return [
    ...members.map((m) => ({
      id: m.id,
      name: m.name,
      note: 'in this room',
      ...(m.assistant ? { assistant: m.assistant } : {}),
    })),
    ...assistants
      .filter((a) => !members.some((m) => m.assistant === a.id) && !taken.has(first(a.title)))
      .map((a) => ({
        id: a.id,
        name: a.title,
        note: a.scope ? `${a.scope} · joins as guest` : 'joins as guest',
        assistant: a.id,
      })),
  ]
}

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
  section: 'Actions',
  item: { kind: 'computer-menu' },
  children: true,
}

/**
 * `@` menu rows for the typed word at one level. Top: the agents, then Computer (opens its
 * modes) and skills (omp's `skill:` commands). Inside Computer: a back row, then Background, Live
 * and Walk. `actions: false` leaves out Computer and skills (a room has no computer runs).
 */
export function atRows(
  commands: readonly SlashCommand[] | null,
  query: string,
  level: AtLevel = 'top',
  agents: readonly AtAgent[] = [],
  actions = true,
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
  // An agent matches when one of the words of its name starts with the typed word.
  const rows: AtRow[] = agents
    .filter((a) =>
      a.name
        .toLowerCase()
        .split(/\s+/)
        .some((w) => w.startsWith(q)),
    )
    .map((a) => ({
      key: `agent:${a.id}`,
      title: a.name,
      description: a.note,
      section: 'Agents',
      item: { kind: 'agent', id: a.id, name: a.name },
    }))
  if (!actions) return rows
  if ('computer'.startsWith(q)) rows.push(COMPUTER_ROW)
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
      section: 'Actions',
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

/** Replaces the `@query` that ends at `caret` with `@First ` and puts the caret after it. */
export function insertAgent(
  text: string,
  caret: number,
  q: { start: number },
  name: string,
): { text: string; caret: number } {
  const token = `@${name.split(/\s+/)[0] ?? name} `
  return { text: text.slice(0, q.start) + token + text.slice(caret), caret: q.start + token.length }
}
