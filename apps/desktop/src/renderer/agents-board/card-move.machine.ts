import { assign, fromPromise, setup } from 'xstate'
import type { AgentCard, AgentColumn } from '@evaos/contract'

/**
 * Dragging a Board card to another column (docs/state-machines/card-move.md): the drop resolves the
 * column to one of the team's Linear states and refuses a move the board would undo ("stays put");
 * several matching states open a picker; Done and Canceled are confirmed and approved by the host's
 * gate (`prepare`) before the write. The write (`commit`) carries an opId minted at the drop and
 * reused on retry, so a lost response never writes twice: the move is `unknown` until `reconcile`
 * reads the ticket's state again. A settled move can be undone for UNDO_WINDOW by the swapped move.
 * The runtime (card-move-actor.ts) provides `resolve`, `prepare`, `commit` and `reconcile`.
 */

export interface MoveState {
  id: string
  name: string
  type: string
}

/** protocol TicketMutation `setState` (a type, so it fits the IPC's loose mutation shape). */
export type SetStateMutation = {
  kind: 'setState'
  issueId: string
  fromStateId: string
  toStateId: string
}

/** What the drop means: one state, a choice, or a refusal with the reason. */
export type MoveResolution =
  | { kind: 'state'; state: MoveState }
  | { kind: 'ambiguous'; options: MoveState[] }
  | { kind: 'stays'; message: string }

export type PrepareResult =
  { kind: 'approved'; approvalId: string } | { kind: 'refused'; code: string; message: string }

export type CommitResult =
  | { kind: 'done' }
  /** The host lost track of whether it wrote (protocol outcome `unknown`). */
  | { kind: 'unknown' }
  | { kind: 'failed'; message: string }
  | { kind: 'refused'; code: string; message: string }

export interface CommitInput {
  opId: string
  approvalId: string | null
  mutation: SetStateMutation
}

/** The write in flight (or last tried): a retry sends it again as is. */
export interface MoveWrite extends CommitInput {
  /** The column the card shows in while it is pending. */
  column: AgentColumn
  /** Moving into Done or Canceled: the host wants an approval. */
  terminal: boolean
}

export interface CardMoveContext {
  card: AgentCard | null
  to: AgentColumn | null
  /** Minted at the drop; the write uses it on every try. */
  opId: string
  target: MoveState | null
  options: MoveState[]
  write: MoveWrite | null
  /** The current write is an Undo (no Undo of an Undo). */
  undo: boolean
  message: string | null
}

export type CardMoveEvent =
  | { type: 'move.drop'; card: AgentCard; to: AgentColumn; opId: string }
  | { type: 'move.pick'; stateId: string }
  | { type: 'move.confirm' }
  | { type: 'move.cancel' }
  /** `currentStateId`: the card's Linear state as the board shows it now (null: not known). */
  | { type: 'move.undo'; currentStateId: string | null; opId: string }
  | { type: 'move.retry' }

const isTerminal = (type: string): boolean => type === 'completed' || type === 'canceled'
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : 'Something went wrong'

export const CHANGED = 'Changed in Linear since you looked; nothing was written'
export const CHECKING = 'Checking whether it moved'

const EMPTY: CardMoveContext = {
  card: null,
  to: null,
  opId: '',
  target: null,
  options: [],
  write: null,
  undo: false,
  message: null,
}

// Guards on actor results (named so the diagram reads them).
type Done<T> = { event: { output: T } }
const stays = ({ event }: Done<MoveResolution>) => event.output.kind === 'stays'
const ambiguous = ({ event }: Done<MoveResolution>) => event.output.kind === 'ambiguous'
const terminalState = ({ event }: Done<MoveResolution>) =>
  event.output.kind === 'state' && isTerminal(event.output.state.type)
const approved = ({ event }: Done<PrepareResult>) => event.output.kind === 'approved'
const written = ({ event }: Done<CommitResult>) => event.output.kind === 'done'
const lost = ({ event }: Done<CommitResult>) => event.output.kind === 'unknown'
const conflicted = ({ event }: Done<PrepareResult | CommitResult>) =>
  event.output.kind === 'refused' && event.output.code === 'conflict'
type Reconciled = { context: CardMoveContext; event: { output: { stateId: string } } }
const landed = ({ context, event }: Reconciled) =>
  event.output.stateId === context.write?.mutation.toStateId
const unmoved = ({ context, event }: Reconciled) =>
  event.output.stateId === context.write?.mutation.fromStateId

/** The message an actor's refusal or failure carries. */
const refusedText = ({ event }: Done<PrepareResult | CommitResult>): string =>
  'message' in event.output ? event.output.message : CHANGED

/** The setState write moving the card's issue to `target`. */
function planWrite(context: CardMoveContext, target: MoveState | null): MoveWrite | null {
  const t = context.card?.ticket
  if (!t || !context.to || !target) return null
  return {
    opId: context.opId,
    mutation: { kind: 'setState', issueId: t.id, fromStateId: t.state.id, toStateId: target.id },
    approvalId: null,
    column: context.to,
    terminal: isTerminal(target.type),
  }
}

export const cardMoveMachine = setup({
  types: {
    context: {} as CardMoveContext,
    events: {} as CardMoveEvent,
  },
  actors: {
    resolve: fromPromise<MoveResolution, { card: AgentCard; to: AgentColumn }>(async () => {
      throw new Error('resolve not provided')
    }),
    prepare: fromPromise<PrepareResult, { mutation: SetStateMutation }>(async () => {
      throw new Error('prepare not provided')
    }),
    commit: fromPromise<CommitResult, CommitInput>(async () => {
      throw new Error('commit not provided')
    }),
    /** The issue's state now, read again after a lost response. */
    reconcile: fromPromise<{ stateId: string }, { key: string }>(async () => {
      throw new Error('reconcile not provided')
    }),
  },
  guards: {
    sameColumn: ({ event }) => event.type === 'move.drop' && event.card.column === event.to,
    blocked: ({ event }) =>
      event.type === 'move.drop' && (event.card.dragBlock !== null || event.card.ticket === null),
    picked: ({ context, event }) =>
      event.type === 'move.pick' && context.options.some((o) => o.id === event.stateId),
    pickedTerminal: ({ context, event }) =>
      event.type === 'move.pick' &&
      context.options.some((o) => o.id === event.stateId && isTerminal(o.type)),
    canUndo: ({ context }) =>
      !context.undo && context.card?.ticket != null && !isTerminal(context.card.ticket.state.type),
    // The card is still in the state it was moved to (or the board can't tell yet).
    stillMoved: ({ context, event }) =>
      event.type === 'move.undo' &&
      (event.currentStateId === null || event.currentStateId === context.write?.mutation.toStateId),
    needsApproval: ({ context }) =>
      context.write !== null && context.write.terminal && context.write.approvalId === null,
    hasWrite: ({ context }) => context.write !== null,
  },
  actions: {
    takeDrop: assign(({ event }) =>
      event.type === 'move.drop'
        ? { ...EMPTY, card: event.card, to: event.to, opId: event.opId }
        : {},
    ),
    refuseBlocked: assign({
      message: ({ event }) =>
        event.type === 'move.drop'
          ? `This card stays put: ${event.card.dragBlock ?? 'No Linear issue'}`
          : null,
    }),
    takePick: assign({
      target: ({ context, event }) =>
        event.type === 'move.pick'
          ? (context.options.find((o) => o.id === event.stateId) ?? null)
          : context.target,
    }),
    planWrite: assign({ write: ({ context }) => planWrite(context, context.target) }),
    planUndo: assign(({ context, event }) => {
      const w = context.write
      if (event.type !== 'move.undo' || !w || !context.card) return {}
      const { fromStateId, toStateId } = w.mutation
      const mutation = { ...w.mutation, fromStateId: toStateId, toStateId: fromStateId }
      const column = context.card.column
      return {
        undo: true,
        write: { opId: event.opId, mutation, approvalId: null, column, terminal: false },
      }
    }),
    refuseUndo: assign({ message: 'Changed in Linear since you moved it; nothing was undone' }),
    clear: assign(() => EMPTY),
  },
  delays: {
    UNDO_WINDOW: 8_000,
  },
}).createMachine({
  id: 'cardMove',
  context: EMPTY,
  initial: 'ready',
  states: {
    // Nothing in flight: a drop starts a new move (and dismisses the last one's message).
    ready: {
      initial: 'idle',
      on: {
        'move.drop': [
          { guard: 'sameColumn', target: '.idle' },
          { guard: 'blocked', target: '.staysPut', actions: ['takeDrop', 'refuseBlocked'] },
          { target: 'checking', actions: 'takeDrop' },
        ],
        'move.cancel': '.idle',
      },
      states: {
        idle: { entry: 'clear' },
        staysPut: {},
        settled: {
          after: { UNDO_WINDOW: 'idle' },
          on: {
            'move.undo': [{ guard: 'canUndo', target: 'undoGate' }],
          },
        },
        // Undo only from the state the move left the card in: else Linear moved on.
        undoGate: {
          always: [
            { guard: 'stillMoved', target: '#cardMove.undoing', actions: 'planUndo' },
            { target: 'conflict', actions: 'refuseUndo' },
          ],
        },
        conflict: {},
        failed: {
          on: {
            'move.retry': [
              { guard: 'needsApproval', target: '#cardMove.preparing' },
              { guard: 'hasWrite', target: '#cardMove.writing' },
              { target: '#cardMove.checking' },
            ],
          },
        },
      },
    },
    checking: {
      invoke: {
        src: 'resolve',
        input: ({ context }) => ({ card: context.card!, to: context.to! }),
        onDone: [
          {
            guard: stays,
            target: 'ready.staysPut',
            actions: assign({
              message: ({ event }) => (event.output.kind === 'stays' ? event.output.message : null),
            }),
          },
          {
            guard: ambiguous,
            target: 'pickState',
            actions: assign({
              options: ({ event }) =>
                event.output.kind === 'ambiguous' ? event.output.options : [],
            }),
          },
          {
            guard: terminalState,
            target: 'confirming',
            actions: assign({
              target: ({ event }) => (event.output.kind === 'state' ? event.output.state : null),
            }),
          },
          {
            target: 'writing',
            actions: [
              assign({
                target: ({ event }) => (event.output.kind === 'state' ? event.output.state : null),
              }),
              'planWrite',
            ],
          },
        ],
        onError: {
          target: 'ready.failed',
          actions: assign({ message: ({ event }) => errorText(event.error) }),
        },
      },
    },
    pickState: {
      on: {
        'move.pick': [
          { guard: 'pickedTerminal', target: 'confirming', actions: 'takePick' },
          { guard: 'picked', target: 'writing', actions: ['takePick', 'planWrite'] },
        ],
        'move.cancel': 'ready',
      },
    },
    confirming: {
      on: {
        'move.confirm': { target: 'preparing', actions: 'planWrite' },
        'move.cancel': 'ready',
      },
    },
    preparing: {
      invoke: {
        src: 'prepare',
        input: ({ context }) => ({ mutation: context.write!.mutation }),
        onDone: [
          {
            guard: approved,
            target: 'writing',
            actions: assign({
              write: ({ context, event }) =>
                event.output.kind === 'approved' && context.write
                  ? { ...context.write, approvalId: event.output.approvalId }
                  : context.write,
            }),
          },
          {
            guard: conflicted,
            target: 'ready.conflict',
            actions: assign({ message: refusedText }),
          },
          { target: 'ready.failed', actions: assign({ message: refusedText }) },
        ],
        onError: {
          target: 'ready.failed',
          actions: assign({ message: ({ event }) => errorText(event.error) }),
        },
      },
    },
    writing: {
      invoke: {
        src: 'commit',
        input: ({ context }) => commitInput(context),
        onDone: [
          { guard: written, target: 'ready.settled' },
          { guard: lost, target: 'unknown' },
          {
            guard: conflicted,
            target: 'ready.conflict',
            actions: assign({ message: refusedText }),
          },
          { target: 'ready.failed', actions: assign({ message: refusedText }) },
        ],
        // No answer: it may have written. Never write again blindly; read the ticket.
        onError: 'unknown',
      },
    },
    undoing: {
      invoke: {
        src: 'commit',
        input: ({ context }) => commitInput(context),
        onDone: [
          { guard: written, target: 'ready.settled' },
          { guard: lost, target: 'unknown' },
          {
            guard: conflicted,
            target: 'ready.conflict',
            actions: assign({ message: refusedText }),
          },
          { target: 'ready.failed', actions: assign({ message: refusedText }) },
        ],
        onError: 'unknown',
      },
    },
    // The response was lost: read the issue's state to learn whether the write landed.
    unknown: {
      invoke: {
        src: 'reconcile',
        input: ({ context }) => ({ key: context.card?.key ?? '' }),
        onDone: [
          { guard: landed, target: 'ready.settled' },
          {
            guard: unmoved,
            target: 'ready.failed',
            actions: assign({ message: 'It didn’t move. Try again.' }),
          },
          { target: 'ready.conflict', actions: assign({ message: CHANGED }) },
        ],
        onError: {
          target: 'ready.failed',
          actions: assign({
            message: ({ event }) => `Couldn’t check whether it moved: ${errorText(event.error)}`,
          }),
        },
      },
    },
  },
})

function commitInput(context: CardMoveContext): CommitInput {
  const { opId, approvalId, mutation } = context.write!
  return { opId, approvalId, mutation }
}
