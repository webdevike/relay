// The runtime for dragging Board cards (card-move.machine.ts): the host's team states and the gate's
// `tickets.prepare` / `tickets.commit`, with `tickets.ticket` to reconcile a lost response. The
// page holds one move at a time; BoardUI renders `view` (toasts, confirm, picker) and moves the
// card to `columnOf` while a write is pending.
import { useMemo } from 'react'
import { useActorRef, useSelector } from '@xstate/react'
import { fromPromise, type SnapshotFrom } from 'xstate'
import { TicketApproval, TicketOutcome, TicketsBoard, TicketState } from '@relay/protocol'
import type { AgentCard, AgentColumn, Result, TicketsFallback } from '@evaos/contract'
import { invoke } from '../ipc'
import {
  CHECKING,
  cardMoveMachine,
  type CommitInput,
  type CommitResult,
  type MoveResolution,
  type PrepareResult,
  type SetStateMutation,
} from './card-move.machine'
import { staysPut, targetState, type TeamState } from './column-states'
import { agentsBoardStore } from './agents-store'

/** The Linear account the Board shows (the host's `tickets.status` identity); writes carry it. */
export function boardViewerId(): string {
  const id = agentsBoardStore.getState().board?.sources.tickets.viewerId ?? null
  if (id === null) throw new Error('The host hasn’t said which Linear account it writes as yet.')
  return id
}

export type MoveView =
  | { kind: 'idle' }
  | { kind: 'checking' | 'preparing' | 'writing' | 'undoing'; cardId: string; to: AgentColumn }
  /** Done/Canceled: the UI confirms (EvaModal). */
  | { kind: 'confirming'; cardId: string; to: AgentColumn; stateName: string }
  /** Several states match the column: the status picker. */
  | { kind: 'pickState'; cardId: string; to: AgentColumn; options: { id: string; name: string }[] }
  /** The drop was refused: "This card stays in X: reason". */
  | { kind: 'staysPut'; cardId: string; to: AgentColumn; message: string }
  | { kind: 'settled'; cardId: string; to: AgentColumn; canUndo: boolean }
  | { kind: 'conflict' | 'failed' | 'unknown'; cardId: string; message: string }

export interface CardMove {
  view: MoveView
  /** Optimistic column for a card while a move is pending (null = use card.column). */
  columnOf(cardId: string): AgentColumn | null
  drop(card: AgentCard, to: AgentColumn): void
  confirm(): void
  pick(stateId: string): void
  cancel(): void
  undo(): void
  retry(): void
}

const served = <T extends { source: string }>(v: T): v is Exclude<T, TicketsFallback> =>
  v.source === 'host'

/** The host's answer, or why there is none, as an error line. */
async function host<T extends { source: string }>(
  answer: Promise<Result<T>>,
): Promise<Exclude<T, TicketsFallback>> {
  const r = await answer
  if (!r.ok) throw new Error(r.error.message)
  if (served(r.value)) return r.value
  const why = 'message' in r.value ? r.value.message : null
  throw new Error(typeof why === 'string' ? why : 'Linear sync needs the Relay Host.')
}

/** The host's board, read with the protocol's schema (main checked it already). */
async function hostBoard(): Promise<TicketsBoard> {
  const { board } = await host(invoke('tickets.board', {}))
  return TicketsBoard.parse(board)
}

/** The team's workflow states from the host's board. */
async function teamStates(teamId: string): Promise<TeamState[]> {
  const team = (await hostBoard()).teams?.find((t) => t.id === teamId)
  if (!team) throw new Error('The host hasn’t sent this team’s states yet.')
  return [...team.states].sort((a, b) => a.position - b.position)
}

async function resolve(card: AgentCard, to: AgentColumn): Promise<MoveResolution> {
  const t = card.ticket
  if (!t) return { kind: 'stays', message: 'This card stays put: No Linear issue' }
  const target = targetState(to, await teamStates(t.team.id), t.state.id)
  if (target.kind === 'none') return { kind: 'stays', message: target.message }
  if (target.kind === 'ambiguous') return target
  const { id, name, type } = target
  const message = staysPut(card, to, target)
  return message ? { kind: 'stays', message } : { kind: 'state', state: { id, name, type } }
}

async function prepare(mutation: SetStateMutation): Promise<PrepareResult> {
  const r = await host(invoke('tickets.prepare', { viewerId: boardViewerId(), mutation }))
  if (r.refused) return { kind: 'refused', ...r.refused }
  return { kind: 'approved', approvalId: TicketApproval.parse(r.approval).id }
}

/** The write; a missing answer rejects, and the machine reads the ticket before anything else. */
async function commit({ opId, approvalId, mutation }: CommitInput): Promise<CommitResult> {
  const input = { viewerId: boardViewerId(), opId, mutation, ...(approvalId ? { approvalId } : {}) }
  const r = await host(invoke('tickets.commit', input))
  if (r.refused) return { kind: 'refused', ...r.refused }
  const outcome = TicketOutcome.parse(r.outcome)
  if (outcome.state === 'done') return { kind: 'done' }
  if (outcome.state === 'unknown') return { kind: 'unknown' }
  return { kind: 'failed', message: outcome.result?.error ?? 'Linear didn’t take the move.' }
}

async function reconcile(key: string): Promise<{ stateId: string }> {
  const { ticket } = await host(invoke('tickets.ticket', { key }))
  return { stateId: TicketState.parse(ticket['state']).id }
}

/** The card's Linear state as the host's board has it now (null: can't tell). */
async function currentState(key: string | null): Promise<string | null> {
  if (!key) return null
  try {
    return (await hostBoard()).tickets.find((t) => t.key === key)?.state.id ?? null
  } catch {
    return null
  }
}
const liveMachine = cardMoveMachine.provide({
  actors: {
    resolve: fromPromise(({ input }) => resolve(input.card, input.to)),
    prepare: fromPromise(({ input }) => prepare(input.mutation)),
    commit: fromPromise(({ input }) => commit(input)),
    reconcile: fromPromise(({ input }) => reconcile(input.key)),
  },
})

type Snap = SnapshotFrom<typeof cardMoveMachine>

const STEPS = ['checking', 'preparing', 'writing', 'undoing'] as const
const PENDING = ['preparing', 'writing', 'undoing', 'unknown'] as const

/** The confirm, the picker or the refusal, when the move waits on Isaac or was refused. */
function promptView(s: Snap, cardId: string, to: AgentColumn): MoveView | null {
  const { target, options, message } = s.context
  if (s.matches('confirming'))
    return { kind: 'confirming', cardId, to, stateName: target?.name ?? '' }
  if (s.matches('pickState'))
    return { kind: 'pickState', cardId, to, options: options.map(({ id, name }) => ({ id, name })) }
  if (s.matches({ ready: 'staysPut' }))
    return { kind: 'staysPut', cardId, to, message: message ?? '' }
  return null
}

/** How the write ended: landed (Undo while it may), still being checked, refused or failed. */
function outcomeView(s: Snap, cardId: string, to: AgentColumn): MoveView {
  if (s.matches({ ready: 'settled' })) {
    const canUndo = s.can({ type: 'move.undo', currentStateId: null, opId: '' })
    return { kind: 'settled', cardId, to, canUndo }
  }
  if (s.matches('unknown')) return { kind: 'unknown', cardId, message: CHECKING }
  const kind = s.matches({ ready: 'conflict' }) ? 'conflict' : 'failed'
  return { kind, cardId, message: s.context.message ?? '' }
}

/** What the page shows for the move now. */
export function moveView(s: Snap): MoveView {
  const { card, to, write } = s.context
  if (!card || !to || s.matches({ ready: 'idle' })) return { kind: 'idle' }
  const step = STEPS.find((k) => s.matches(k))
  const column = write?.column ?? to
  if (step) return { kind: step, cardId: card.id, to: column }
  return promptView(s, card.id, to) ?? outcomeView(s, card.id, column)
}

/** `cardId\ncolumn` while a write is pending or just landed; '' otherwise (rolled back). */
export function pendingColumn(s: Snap): string {
  const pending = PENDING.some((k) => s.matches(k)) || s.matches({ ready: 'settled' })
  const { card, write } = s.context
  if (!card || !write || !pending) return ''
  return `${card.id}\n${write.column}`
}

const sameView = (a: MoveView, b: MoveView): boolean => JSON.stringify(a) === JSON.stringify(b)

export function useCardMove(): CardMove {
  const actor = useActorRef(liveMachine)
  const view = useSelector(actor, moveView, sameView)
  const pending = useSelector(actor, pendingColumn)
  return useMemo(() => {
    const [pendingId, pendingTo] = pending.split('\n')
    return {
      view,
      columnOf: (cardId) => (pending && cardId === pendingId ? (pendingTo as AgentColumn) : null),
      drop: (card, to) => actor.send({ type: 'move.drop', card, to, opId: crypto.randomUUID() }),
      confirm: () => actor.send({ type: 'move.confirm' }),
      pick: (stateId) => actor.send({ type: 'move.pick', stateId }),
      cancel: () => actor.send({ type: 'move.cancel' }),
      undo: () => {
        void currentState(actor.getSnapshot().context.card?.key ?? null).then((id) =>
          actor.send({ type: 'move.undo', currentStateId: id, opId: crypto.randomUUID() }),
        )
      },
      retry: () => actor.send({ type: 'move.retry' }),
    }
  }, [actor, view, pending])
}
