import { assign, setup, stateIn } from 'xstate'

/**
 * How a live agent's edits show in a rendered Markdown file (docs/state-machines/agent-follow.md).
 * Two regions: whether Isaac is working in the editor (typing, clicking or scrolling in the last
 * ISAAC_GRACE), and where the agent's latest edit is. An edit on screen just shows (its caret,
 * avatar and caption). An edit off screen scrolls into view while Isaac is idle, so a doc an agent
 * writes streams in where he can see it; while he is working his view never moves, and a pill
 * says who is editing and where, one click from it. The agent leaves when its marks fade.
 */

export interface FollowAgent {
  name: string
  color: string
  avatarUrl?: string
  intent?: string
  /** The buffer line of its latest edit. */
  line: number
  /** Where that line is while it is off screen; null while it is on screen. */
  side: 'above' | 'below' | null
}

export type FollowEvent =
  /** Isaac typed, clicked or scrolled in the editor. */
  | { type: 'isaac.active' }
  /** An agent's write landed; `side` is null when its line is on screen, else where it is. */
  | { type: 'agent.edited'; agent: Omit<FollowAgent, 'side'>; side: 'above' | 'below' | null }
  /** Its marks faded (presence-store): nobody is editing. */
  | { type: 'agent.left' }
  /** Isaac clicked the pill. */
  | { type: 'agent.jump' }

export const ISAAC_GRACE_MS = 4000

export const agentFollowMachine = setup({
  types: {
    context: {} as { agent: FollowAgent | null },
    events: {} as FollowEvent,
  },
  actions: {
    // Provided by the runtime: scroll the agent's line into view.
    reveal: (_, _params: { line: number }) => undefined,
  },
  guards: {
    onScreen: ({ event }) => event.type === 'agent.edited' && event.side === null,
    isaacIdle: stateIn({ isaac: 'idle' }),
  },
  delays: { ISAAC_GRACE: ISAAC_GRACE_MS },
}).createMachine({
  id: 'agentFollow',
  type: 'parallel',
  context: { agent: null },
  states: {
    isaac: {
      initial: 'idle',
      states: {
        idle: { on: { 'isaac.active': 'active' } },
        active: {
          after: { ISAAC_GRACE: 'idle' },
          on: { 'isaac.active': { target: 'active', reenter: true } },
        },
      },
    },
    agent: {
      initial: 'none',
      on: {
        'agent.edited': [
          {
            guard: 'onScreen',
            target: '.inView',
            actions: assign({ agent: ({ event }) => ({ ...event.agent, side: null }) }),
          },
          {
            guard: 'isaacIdle',
            target: '.inView',
            actions: [
              assign({ agent: ({ event }) => ({ ...event.agent, side: null }) }),
              { type: 'reveal', params: ({ event }) => ({ line: event.agent.line }) },
            ],
          },
          {
            target: '.offScreen',
            actions: assign({ agent: ({ event }) => ({ ...event.agent, side: event.side }) }),
          },
        ],
        'agent.left': { target: '.none', actions: assign({ agent: null }) },
      },
      states: {
        none: {},
        inView: {},
        offScreen: {
          on: {
            'agent.jump': {
              target: 'inView',
              actions: [
                { type: 'reveal', params: ({ context }) => ({ line: context.agent?.line ?? 1 }) },
                assign({
                  agent: ({ context }) => context.agent && { ...context.agent, side: null },
                }),
              ],
            },
          },
        },
      },
    },
  },
})
