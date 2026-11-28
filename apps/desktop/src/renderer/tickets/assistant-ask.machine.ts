import { assign, fromPromise, setup } from 'xstate'

/** What the assistant's item session says about the newest ask. */
export interface AskProgress {
  /** She is on it (or the ask is queued). */
  working: boolean
  /** Some answer of hers follows the ask. */
  answered: boolean
  error: string | null
}

/** One ask as the session gets it; `thread` is the root it continues (null: a new thread). */
export interface AskInput {
  text: string
  thread: string | null
}

export type SendResult =
  | { kind: 'sent'; progress: AskProgress }
  /** No answer came back: it may have reached her (a timeout). */
  | { kind: 'lost' }
  | { kind: 'failed'; message: string }

export interface AssistantAskContext {
  ask: AskInput | null
  /** The root of the thread the last ask went to: a follow-up without one continues it. */
  thread: string | null
  progress: AskProgress | null
  error: string | null
}

export type AssistantAskEvent =
  | { type: 'ask.send'; text: string }
  | { type: 'ask.followUp'; text: string; thread?: string }
  | { type: 'ask.update'; progress: AskProgress }
  | { type: 'ask.retry' }
  | { type: 'ask.dismiss' }
  | { type: 'ask.disconnected' }
  | { type: 'ask.reconnected' }

export const NOT_DELIVERED = 'Your question didn’t go out. Retry sends it again.'

const asks = {
  'ask.send': { target: '#assistantAsk.sending', actions: 'newAsk' },
  'ask.followUp': { target: '#assistantAsk.sending', actions: 'followUp' },
} as const

/**
 * One assistant's private asks on an item (PLAN T4.2): an ask goes out (`sending`), she works on it
 * (`answering`, her text streaming into the thread) until her turn ends (`answered`). An ask that
 * didn't reach her is `failed` (Retry sends the same text); a connection lost while she answers is
 * `interrupted` until Relay is back, then the session's snapshot says where she is. A follow-up
 * continues the same thread. Nothing here is posted anywhere: asks are Relay-only.
 */
export const assistantAskMachine = setup({
  types: {
    context: {} as AssistantAskContext,
    events: {} as AssistantAskEvent,
  },
  actors: {
    send: fromPromise<SendResult, AskInput>(() => Promise.resolve({ kind: 'lost' })),
    restore: fromPromise<AskProgress | null, void>(() => Promise.resolve(null)),
  },
  actions: {
    newAsk: assign(({ event }) => {
      const text = event.type === 'ask.send' ? event.text : ''
      return { ask: { text, thread: null }, thread: text, progress: null, error: null }
    }),
    followUp: assign(({ context, event }) => {
      if (event.type !== 'ask.followUp') return {}
      const thread = event.thread ?? context.thread
      // No thread yet: the follow-up starts one.
      return {
        ask: { text: event.text, thread },
        thread: thread ?? event.text,
        progress: null,
        error: null,
      }
    }),
    setProgress: assign((_, progress: AskProgress | null) => ({ progress })),
    setError: assign((_, error: string) => ({ error })),
  },
  guards: {
    lost: (_, out: SendResult) => out.kind === 'lost',
    sent: (_, out: SendResult) => out.kind === 'sent',
    broke: ({ context: { progress: p } }) =>
      p !== null && !p.working && !p.answered && p.error !== null,
    finished: ({ context: { progress: p } }) => p !== null && !p.working,
    stillWorking: (_, out: AskProgress | null) => out?.working === true,
    hasAnswer: (_, out: AskProgress | null) => out?.answered === true,
  },
}).createMachine({
  id: 'assistantAsk',
  context: { ask: null, thread: null, progress: null, error: null },
  initial: 'idle',
  states: {
    idle: { on: asks },
    sending: {
      invoke: {
        src: 'send',
        input: ({ context }) => context.ask!,
        onDone: [
          { guard: { type: 'lost', params: ({ event }) => event.output }, target: 'interrupted' },
          {
            guard: { type: 'sent', params: ({ event }) => event.output },
            target: 'answering',
            actions: {
              type: 'setProgress',
              params: ({ event }) => (event.output.kind === 'sent' ? event.output.progress : null),
            },
          },
          {
            target: 'failed',
            actions: {
              type: 'setError',
              params: ({ event }) =>
                event.output.kind === 'failed' ? event.output.message : NOT_DELIVERED,
            },
          },
        ],
        onError: { target: 'failed', actions: { type: 'setError', params: NOT_DELIVERED } },
      },
    },
    answering: {
      always: [
        {
          guard: 'broke',
          target: 'failed',
          actions: {
            type: 'setError',
            params: ({ context }) => context.progress?.error ?? NOT_DELIVERED,
          },
        },
        { guard: 'finished', target: 'answered' },
      ],
      on: {
        // A new ask while she works goes to her as well (omp takes it as a steer).
        ...asks,
        'ask.update': { actions: { type: 'setProgress', params: ({ event }) => event.progress } },
        'ask.disconnected': 'interrupted',
      },
    },
    answered: { on: asks },
    failed: {
      on: {
        ...asks,
        'ask.retry': { target: 'sending', actions: assign({ error: null }) },
        'ask.dismiss': { target: 'idle', actions: assign({ error: null }) },
      },
    },
    interrupted: {
      on: { 'ask.reconnected': 'restoring', 'ask.dismiss': 'idle' },
    },
    restoring: {
      invoke: {
        src: 'restore',
        onDone: [
          {
            guard: { type: 'stillWorking', params: ({ event }) => event.output },
            target: 'answering',
            actions: { type: 'setProgress', params: ({ event }) => event.output },
          },
          {
            guard: { type: 'hasAnswer', params: ({ event }) => event.output },
            target: 'answered',
            actions: { type: 'setProgress', params: ({ event }) => event.output },
          },
          { target: 'failed', actions: { type: 'setError', params: NOT_DELIVERED } },
        ],
        onError: 'interrupted',
      },
    },
  },
})
