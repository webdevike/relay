import { assign, setup } from 'xstate'

/**
 * A prototype card's live page (docs/state-machines/proto-frame.md): the card's frame boots once
 * with the card's code, and every later edit of the code goes to the running page as a new
 * revision (no reload), so an agent's edit redraws in place. The page answers each revision:
 * drawn (`live`) or not (`failed`: it does not compile or threw while drawing; the page keeps its
 * last good render and the card shows why). A page that never answers is booted again, and a new
 * theme, scheme or design system boots it again from the last good code, then sends the newest.
 * The runtime (ProtoPage in CanvasCard.tsx) provides `post` and sends the frame's answers.
 */

export interface ProtoFrameContext {
  /** The card's newest code. */
  latest: string
  /** The revision of `latest` the page was last sent (0: the code it booted with). */
  rev: number
  /** The code the page boots with (in its URL). */
  bootSource: string
  /** Bumped on every boot: the frame element is keyed by it, so a boot is a fresh page. */
  boot: number
  /** The last code the page drew, to boot from after a theme change. */
  good: string | null
  /** Why the newest revision did not draw. */
  error: string | null
}

export type ProtoFrameEvent =
  /** The card's code changed (an agent's edit, Isaac's undo, a board reload). */
  | { type: 'source.changed'; source: string }
  /** The page's answer for revision `rev`. */
  | { type: 'frame.rendered'; rev: number; ok: boolean; error?: string | undefined }
  /** The page's theme, scheme or design system changed: boot a new page. */
  | { type: 'frame.reboot' }

export const protoFrameMachine = setup({
  types: {
    input: {} as { source: string },
    context: {} as ProtoFrameContext,
    events: {} as ProtoFrameEvent,
  },
  actions: {
    // Posts `latest` to the page as revision `rev`.
    post: () => {
      throw new Error('post not provided')
    },
    remember: assign({
      latest: ({ context, event }) =>
        event.type === 'source.changed' ? event.source : context.latest,
    }),
    nextRev: assign({ rev: ({ context }) => context.rev + 1 }),
    // The page's answer: what it drew becomes the good code, or why it did not is kept.
    settle: assign(({ context, event }) => {
      if (event.type !== 'frame.rendered') return {}
      if (!event.ok) return { error: event.error ?? 'It did not draw' }
      return { good: context.rev === 0 ? context.bootSource : context.latest, error: null }
    }),
    timedOut: assign({ error: 'The page did not load' }),
    reboot: assign({
      boot: ({ context }) => context.boot + 1,
      bootSource: ({ context }) => context.good ?? context.latest,
      rev: 0,
    }),
  },
  guards: {
    // The page answered the revision it was last sent.
    current: ({ context, event }) => event.type === 'frame.rendered' && event.rev === context.rev,
    // ...and the code moved on since the page booted.
    answeredBehind: ({ context, event }) =>
      event.type === 'frame.rendered' &&
      event.rev === context.rev &&
      context.latest !== context.bootSource,
    // ...and drew it.
    answeredOk: ({ context, event }) =>
      event.type === 'frame.rendered' && event.rev === context.rev && event.ok,
    changed: ({ context, event }) =>
      event.type === 'source.changed' && event.source !== context.latest,
  },
  delays: {
    BOOT_TIMEOUT: 15_000,
    RENDER_TIMEOUT: 5_000,
  },
}).createMachine({
  id: 'protoFrame',
  context: ({ input }) => ({
    latest: input.source,
    rev: 0,
    bootSource: input.source,
    boot: 0,
    good: null,
    error: null,
  }),
  initial: 'booting',
  on: {
    'frame.reboot': { target: '.booting', actions: 'reboot', reenter: true },
  },
  states: {
    booting: {
      tags: ['busy'],
      on: {
        'source.changed': { actions: 'remember' },
        'frame.rendered': [
          // The code moved on while the page booted: send the newest.
          { guard: 'answeredBehind', target: 'rendering', actions: 'settle' },
          { guard: 'answeredOk', target: 'live', actions: 'settle' },
          { guard: 'current', target: 'failed', actions: 'settle' },
        ],
      },
      after: { BOOT_TIMEOUT: { target: 'failed', actions: 'timedOut' } },
    },
    rendering: {
      tags: ['busy'],
      entry: ['nextRev', 'post'],
      on: {
        'source.changed': {
          guard: 'changed',
          target: 'rendering',
          reenter: true,
          actions: 'remember',
        },
        'frame.rendered': [
          { guard: 'answeredOk', target: 'live', actions: 'settle' },
          { guard: 'current', target: 'failed', actions: 'settle' },
        ],
      },
      after: { RENDER_TIMEOUT: { target: 'booting', actions: 'reboot' } },
    },
    live: {
      on: {
        'source.changed': { guard: 'changed', target: 'rendering', actions: 'remember' },
      },
    },
    failed: {
      tags: ['error'],
      on: {
        'source.changed': { guard: 'changed', target: 'rendering', actions: 'remember' },
      },
    },
  },
})
