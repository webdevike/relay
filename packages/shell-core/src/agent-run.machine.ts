import { assign, setup } from 'xstate'

/**
 * One agent's run on one surface Isaac sees (a web page, a canvas board; later Relay Assist's
 * screen overlay): what its ring, caption row and work card show, and who may act. Pure: the
 * runtime (desktop main agent-presence/agent-runs.ts) provides the effects (hide the cursor,
 * settle an action waiting for Allow, wake agents waiting for Hand back) and publishes each
 * snapshot as an AgentRun. Docs: docs/state-machines/agent-run.md.
 */

/** Who acts, as the surface shows it (AgentIdentity plus whatever the runtime carries along). */
export interface RunWho {
  id: string | null
  name: string
  color: string
}

export interface RunContext<W extends RunWho = RunWho> {
  who: W
  /** One line: what it is doing, or how it ended. */
  caption: string
  /** The caption is the runtime's own (`Clicking "Buy"`), so the next action may replace it. */
  autoCaption: boolean
  /** The action waiting for Isaac's Allow (state `asking`). */
  ask: { id: string; label: string } | null
  since: number
  ended: number | null
}

export type RunEvent<W extends RunWho = RunWho> =
  /** An agent acts: starts a run (idle, done, stopped) or goes on with its own (working). */
  | { type: 'run.begin'; who: W; caption?: string | undefined; now: number }
  /** A caption: the agent's own (`auto` false), or the runtime's, which never replaces the agent's. */
  | { type: 'run.caption'; text: string; auto: boolean }
  /** An action finished: the idle clock starts again. */
  | { type: 'run.touch' }
  /** A consequential action waits for Isaac's Allow. */
  | { type: 'run.ask'; id: string; label: string }
  | { type: 'run.finish'; who: W; summary: string; outcome: 'done' | 'stopped'; now: number }
  | { type: 'isaac.takeOver' }
  | { type: 'isaac.handBack' }
  | { type: 'isaac.allow' }
  | { type: 'isaac.deny'; now: number }
  | { type: 'isaac.dismiss' }

export interface RunInput<W extends RunWho = RunWho> {
  who: W
  since: number
}

/** A working run with no action for this long goes idle. */
export const RUN_IDLE_MS = 120_000

export const agentRunMachine = setup({
  types: {
    context: {} as RunContext,
    events: {} as RunEvent,
    input: {} as RunInput,
  },
  actions: {
    /** The agent's cursor leaves the surface. */
    hideCursor: () => {},
    /** The action waiting for Allow fails: Isaac took over (`paused`) or said not now. */
    releasePending: (_, _params: { paused: boolean }) => {},
    /** Isaac allowed the waiting action: it runs now. */
    runPending: () => {},
    /** Agents waiting for Hand back go on. */
    resumeWaiters: () => {},
    startFresh: assign(({ event }) => {
      if (event.type !== 'run.begin') return {}
      return {
        who: event.who,
        caption: event.caption ?? '',
        autoCaption: false,
        ask: null,
        since: event.now,
        ended: null,
      }
    }),
    goOn: assign(({ event }) => {
      if (event.type !== 'run.begin') return {}
      return event.caption === undefined
        ? { who: event.who }
        : { who: event.who, caption: event.caption, autoCaption: false }
    }),
    setCaption: assign(({ event }) =>
      event.type === 'run.caption' ? { caption: event.text, autoCaption: event.auto } : {},
    ),
    setAsk: assign(({ event }) =>
      event.type === 'run.ask' ? { ask: { id: event.id, label: event.label } } : {},
    ),
    clearAsk: assign({ ask: null }),
    clearCaption: assign({ caption: '', autoCaption: false }),
    stopBeforeAsk: assign(({ context, event }) => ({
      caption: `Stopped before: ${context.ask?.label ?? 'that'}`,
      autoCaption: false,
      ask: null,
      ended: event.type === 'isaac.deny' ? event.now : context.ended,
    })),
    finish: assign(({ event }) => {
      if (event.type !== 'run.finish') return {}
      return {
        who: event.who,
        caption: event.summary,
        autoCaption: false,
        ask: null,
        ended: event.now,
      }
    }),
  },
  guards: {
    /** The runtime's caption never replaces one the agent wrote. */
    captionAllowed: ({ context, event }) =>
      event.type === 'run.caption' &&
      (!event.auto || context.caption === '' || context.autoCaption),
    isStopped: ({ event }) => event.type === 'run.finish' && event.outcome === 'stopped',
  },
  delays: { idleTimeout: RUN_IDLE_MS },
}).createMachine({
  id: 'agentRun',
  initial: 'idle',
  context: ({ input }) => ({
    who: input.who,
    caption: '',
    autoCaption: false,
    ask: null,
    since: input.since,
    ended: null,
  }),
  on: {
    'run.finish': [
      {
        guard: 'isStopped',
        target: '.stopped',
        actions: [{ type: 'releasePending', params: { paused: false } }, 'finish', 'hideCursor'],
      },
      {
        target: '.done',
        actions: [{ type: 'releasePending', params: { paused: false } }, 'finish', 'hideCursor'],
      },
    ],
  },
  states: {
    idle: {
      on: { 'run.begin': { target: 'working', actions: 'startFresh' } },
    },
    working: {
      after: {
        idleTimeout: { target: 'idle', actions: ['clearCaption', 'hideCursor'] },
      },
      on: {
        'run.begin': { target: 'working', reenter: true, actions: 'goOn' },
        'run.touch': { target: 'working', reenter: true },
        'run.caption': { guard: 'captionAllowed', actions: 'setCaption' },
        'run.ask': { target: 'asking', actions: 'setAsk' },
        'isaac.takeOver': { target: 'paused', actions: 'hideCursor' },
      },
    },
    asking: {
      on: {
        'run.caption': { guard: 'captionAllowed', actions: 'setCaption' },
        'isaac.allow': { target: 'working', actions: ['clearAsk', 'runPending'] },
        'isaac.takeOver': {
          target: 'paused',
          actions: [{ type: 'releasePending', params: { paused: true } }, 'clearAsk', 'hideCursor'],
        },
        'isaac.deny': {
          target: 'stopped',
          actions: [
            { type: 'releasePending', params: { paused: false } },
            'stopBeforeAsk',
            'hideCursor',
          ],
        },
      },
    },
    paused: {
      on: { 'isaac.handBack': { target: 'working', actions: 'resumeWaiters' } },
    },
    done: {
      on: {
        'run.begin': { target: 'working', actions: 'startFresh' },
        'isaac.dismiss': { target: 'idle', actions: 'clearCaption' },
      },
    },
    stopped: {
      on: {
        'run.begin': { target: 'working', actions: 'startFresh' },
        'isaac.dismiss': { target: 'idle', actions: 'clearCaption' },
      },
    },
  },
})

/** The AgentRun status a state stands for (`asking` is `ask`). */
export type RunStatus = 'working' | 'paused' | 'ask' | 'done' | 'stopped' | 'idle'

const STATUS: Record<string, RunStatus> = {
  idle: 'idle',
  working: 'working',
  asking: 'ask',
  paused: 'paused',
  done: 'done',
  stopped: 'stopped',
}

/** A snapshot as the surface draws it (AgentRun without the surface's own `background`). */
export function runView(snapshot: { value: unknown; context: RunContext }): {
  id: string | null
  name: string
  color: string
  status: RunStatus
  caption: string
  ask: { id: string; label: string } | null
  since: number
  ended: number | null
} {
  const c = snapshot.context
  return {
    id: c.who.id,
    name: c.who.name,
    color: c.who.color,
    status: STATUS[String(snapshot.value)] ?? 'idle',
    caption: c.caption,
    ask: c.ask,
    since: c.since,
    ended: c.ended,
  }
}

/** Runs that hold the surface: another agent may not act there meanwhile. */
export const ACTIVE_STATUS: Readonly<Record<RunStatus, boolean>> = {
  working: true,
  paused: true,
  ask: true,
  done: false,
  stopped: false,
  idle: false,
}
