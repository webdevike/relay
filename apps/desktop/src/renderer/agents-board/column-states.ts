// Which Linear workflow state a Board column means, and whether a card dropped there would stay:
// the board places cards from their facts (an agent's run, an open PR), so a move that the next
// board load would undo is refused before anything is written. Pure.
import type { AgentCard, AgentColumn } from '@evaos/contract'

/** One of a team's workflow states (protocol TicketTeam.states). */
export interface TeamState {
  id: string
  name: string
  type: string
}

export type TargetState =
  | { kind: 'state'; id: string; name: string; type: string }
  /** Several states could be meant: the status picker asks. */
  | { kind: 'ambiguous'; options: TeamState[] }
  | { kind: 'none'; message: string }

/** Column titles for messages (board-view's COLUMN_TITLE, kept here so this stays pure of UI). */
const COLUMN_NAME: Record<AgentColumn, string> = {
  queued: 'Queued',
  working: 'Working',
  needs: 'Needs Isaac',
  review: 'In review',
  qa: 'Merged/QA',
  done: 'Done',
}

/** The state each column means by name, as Linear's default workflow names them. */
const COLUMN_STATE: Record<AgentColumn, string> = {
  queued: 'todo',
  working: 'in progress',
  needs: 'design review',
  review: 'in review',
  qa: 'in qa',
  done: 'done',
}

/** The workflow type a column means when the team has no state of that name. */
const COLUMN_TYPE: Partial<Record<AgentColumn, string>> = {
  queued: 'unstarted',
  working: 'started',
  done: 'completed',
}

/** Done and Canceled: a move there is confirmed first. */
export const isTerminal = (type: string): boolean => type === 'completed' || type === 'canceled'

const named = (s: Pick<TeamState, 'name'>, name: string): boolean =>
  s.name.trim().toLowerCase() === name

/**
 * The state a drop on `column` writes: the team's state of the column's name, else the one state
 * of the column's workflow type; several of that type ask, none says so. `currentStateId`: the
 * card's state now (a move to where it already is writes nothing).
 */
export function targetState(
  column: AgentColumn,
  teamStates: readonly TeamState[],
  currentStateId: string,
): TargetState {
  const exact = teamStates.find((s) => named(s, COLUMN_STATE[column]))
  const type = COLUMN_TYPE[column]
  const ofType = type ? teamStates.filter((s) => s.type === type) : []
  const hit = exact ?? (ofType.length === 1 ? ofType[0] : undefined)
  if (hit?.id === currentStateId) return { kind: 'none', message: `It's already ${hit.name}` }
  if (hit) return { kind: 'state', id: hit.id, name: hit.name, type: hit.type }
  if (ofType.length > 1) return { kind: 'ambiguous', options: ofType }
  return {
    kind: 'none',
    message: `No Linear state matches ${COLUMN_NAME[column]} for this team`,
  }
}

/** Where a synced issue with no agent work lands in a state (derive.ts placeSynced). */
function ticketColumn(
  t: NonNullable<AgentCard['ticket']>,
  target: Pick<TeamState, 'name' | 'type'>,
): { column: AgentColumn; reason: string } {
  const lin = { reason: `Linear's ${target.name} puts it there` }
  if (isTerminal(target.type)) return { column: 'done', ...lin }
  if (named(target, 'in qa')) return { column: 'qa', ...lin }
  if (named(target, 'in review')) return { column: 'review', ...lin }
  const pr = t.prs.find((p) => p.state === 'open')
  if (pr) return { column: 'review', reason: `PR #${pr.number} is open` }
  if (named(target, 'design review')) return { column: 'needs', ...lin }
  return { column: target.type === 'started' ? 'working' : 'queued', ...lin }
}

/** Whether the card's column now comes from its Linear state (derive.ts placeTicket's Linear rules). */
function linearDriven(card: AgentCard): boolean {
  const state = card.linear?.state ?? ''
  if (card.column === 'done') return isTerminal(card.linear?.stateType ?? '')
  if (card.column === 'qa') return /\bqa\b/i.test(state)
  return card.column === 'review' && /review/i.test(state)
}

/**
 * Where an agent card lands in a state: Linear only decides Done, then QA and review by name;
 * otherwise its agent facts (run, ledger, PR) keep it where it is.
 */
function itemColumn(
  card: AgentCard,
  target: Pick<TeamState, 'name' | 'type'>,
): { column: AgentColumn; reason: string } {
  const lin = { reason: `Linear's ${target.name} puts it there` }
  if (isTerminal(target.type)) return { column: 'done', ...lin }
  const from = linearDriven(card) ? 'queued' : card.column
  const ranked = from === 'queued' || from === 'review'
  if (ranked && /\bqa\b/i.test(target.name)) return { column: 'qa', ...lin }
  if (from === 'queued' && /review/i.test(target.name)) return { column: 'review', ...lin }
  return { column: from, reason: from === card.column ? card.reason : lin.reason }
}

/**
 * Why a card dropped on `column` in `target` state would end up elsewhere on the next board load
 * ("This card stays in Working: ..."), or null when the move sticks.
 */
export function staysPut(
  card: AgentCard,
  column: AgentColumn,
  target: Pick<TeamState, 'name' | 'type'>,
): string | null {
  if (card.dragBlock) return `This card stays in ${COLUMN_NAME[card.column]}: ${card.dragBlock}`
  if (!card.ticket) return `This card stays in ${COLUMN_NAME[card.column]}: No Linear issue`
  const lands =
    card.kind === 'ticket' ? ticketColumn(card.ticket, target) : itemColumn(card, target)
  if (lands.column === column) return null
  return `This card stays in ${COLUMN_NAME[lands.column]}: ${lands.reason}`
}
