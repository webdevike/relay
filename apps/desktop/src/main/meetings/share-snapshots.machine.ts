import { assign, setup } from 'xstate'
import type { MeetingShare } from '@relay/protocol'

/**
 * When to snapshot a screen share in one recording (docs/state-machines/share-snapshots.md). The
 * meeting helper says when someone starts or stops sharing and whether Relay may capture the
 * screen; while it may, this asks for a sample every `SAMPLE_EVERY`, compares the sample's dHash
 * with the last saved one and asks the helper to save it only when enough of the picture changed
 * (`percent` of the 256 bits; the first sample of every share always saves). Every ask carries a
 * `seq` and only the answer to the latest one counts, so a late answer after a timeout cannot move
 * it. The host hears `meeting.share` through `reportShare` on every change: entering `blocked` or
 * `sharing` always is one, and leaving them for `idle` or `stopped` reports `none`. The runtime
 * (share-snapshots.ts) provides `askSample`, `askSave`, `reportShare` and `warn`.
 */

export interface ShareSnapshotsInput {
  /** Percent of the hash that must differ from the last saved shot (`meetings.snapshotChange`). */
  percent: number
}

export interface ShareSnapshotsContext {
  percent: number
  /** The latest ask; answers with another seq are stale. */
  seq: number
  /** The hash of the last shot saved in this share; null until the first one is. */
  savedHash: string | null
  /** The hash of the sample being saved now. */
  heldHash: string | null
}

export type ShareSnapshotsEvent =
  /** Someone shares their screen in this call (again when `permission` changes). */
  | { type: 'share.on'; permission: boolean }
  /** Nobody shares any more. */
  | { type: 'share.off' }
  /** The helper captured sample `seq`. */
  | { type: 'share.sampled'; seq: number; hash: string }
  | { type: 'share.sample.failed'; seq: number; reason: string }
  /** The helper saved sample `seq` as shot `n`. */
  | { type: 'share.saved'; seq: number; n: number }
  | { type: 'share.save.failed'; seq: number; reason: string }
  /** The setting changed. */
  | { type: 'share.threshold'; percent: number }
  /** The recording stopped. */
  | { type: 'share.stop' }

const HASH = /^[0-9a-f]{64}$/i

/** Bits that differ between two 64-hex (256-bit) hashes. */
export function hashDistance(a: string, b: string): number {
  let bits = 0
  for (let i = 0; i < 64; i += 8) {
    let x = (parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0
    while (x !== 0) {
      x &= x - 1
      bits++
    }
  }
  return bits
}

export const shareSnapshotsMachine = setup({
  types: {
    input: {} as ShareSnapshotsInput,
    context: {} as ShareSnapshotsContext,
    events: {} as ShareSnapshotsEvent,
  },
  actions: {
    // The runtime writes these to the helper and the host.
    askSample: (_, _params: { seq: number }) => {},
    askSave: (_, _params: { seq: number }) => {},
    reportShare: (_, _params: { state: MeetingShare }) => {},
    warn: (_, _params: { message: string }) => {},
    nextSeq: assign({ seq: ({ context }) => context.seq + 1 }),
    forgetSaved: assign({ savedHash: null, heldHash: null }),
    holdHash: assign({
      heldHash: ({ event }) => (event.type === 'share.sampled' ? event.hash : null),
    }),
    rememberSaved: assign({ savedHash: ({ context }) => context.heldHash, heldHash: null }),
    setPercent: assign({
      percent: ({ context, event }) =>
        event.type === 'share.threshold' ? event.percent : context.percent,
    }),
  },
  // The sample guards include the seq check so the diagram names each decision once.
  guards: {
    permitted: ({ event }) => event.type === 'share.on' && event.permission,
    denied: ({ event }) => event.type === 'share.on' && !event.permission,
    isCurrent: ({ context, event }) => 'seq' in event && event.seq === context.seq,
    isUnreadable: ({ context, event }) =>
      event.type === 'share.sampled' && event.seq === context.seq && !HASH.test(event.hash),
    changedEnough: ({ context, event }) =>
      event.type === 'share.sampled' &&
      event.seq === context.seq &&
      (context.savedHash === null ||
        hashDistance(event.hash, context.savedHash) / 256 >= context.percent / 100),
  },
  delays: {
    SAMPLE_EVERY: 3_000,
    SAMPLE_TIMEOUT: 10_000,
    SAVE_TIMEOUT: 30_000,
  },
}).createMachine({
  id: 'shareSnapshots',
  context: ({ input }) => ({ percent: input.percent, seq: 0, savedHash: null, heldHash: null }),
  initial: 'idle',
  on: {
    'share.threshold': { actions: 'setPercent' },
  },
  states: {
    idle: {
      on: {
        'share.on': [{ guard: 'permitted', target: 'sharing' }, { target: 'blocked' }],
        'share.stop': 'stopped',
      },
    },
    blocked: {
      entry: { type: 'reportShare', params: { state: 'no-permission' } },
      on: {
        'share.on': { guard: 'permitted', target: 'sharing' },
        'share.off': {
          target: 'idle',
          actions: { type: 'reportShare', params: { state: 'none' } },
        },
        'share.stop': {
          target: 'stopped',
          actions: { type: 'reportShare', params: { state: 'none' } },
        },
      },
    },
    sharing: {
      // A new share compares against nothing, so its first sample always saves.
      entry: ['forgetSaved', { type: 'reportShare', params: { state: 'sharing' } }],
      on: {
        'share.on': { guard: 'denied', target: 'blocked' },
        'share.off': {
          target: 'idle',
          actions: { type: 'reportShare', params: { state: 'none' } },
        },
        'share.stop': {
          target: 'stopped',
          actions: { type: 'reportShare', params: { state: 'none' } },
        },
      },
      initial: 'waiting',
      states: {
        waiting: {
          after: { SAMPLE_EVERY: 'sampling' },
        },
        sampling: {
          entry: [
            'nextSeq',
            { type: 'askSample', params: ({ context }) => ({ seq: context.seq }) },
          ],
          on: {
            'share.sampled': [
              {
                guard: 'isUnreadable',
                target: 'waiting',
                actions: {
                  type: 'warn',
                  params: ({ event }) => ({
                    message: `share sample has an unreadable hash: ${event.hash}`,
                  }),
                },
              },
              {
                guard: 'changedEnough',
                target: 'saving',
                actions: 'holdHash',
              },
              { guard: 'isCurrent', target: 'waiting' },
            ],
            'share.sample.failed': {
              guard: 'isCurrent',
              target: 'waiting',
              actions: {
                type: 'warn',
                params: ({ event }) => ({ message: `share sample failed: ${event.reason}` }),
              },
            },
          },
          after: {
            SAMPLE_TIMEOUT: {
              target: 'waiting',
              actions: { type: 'warn', params: { message: 'share sample timed out' } },
            },
          },
        },
        saving: {
          entry: { type: 'askSave', params: ({ context }) => ({ seq: context.seq }) },
          on: {
            'share.saved': { guard: 'isCurrent', target: 'waiting', actions: 'rememberSaved' },
            'share.save.failed': {
              guard: 'isCurrent',
              target: 'waiting',
              actions: {
                type: 'warn',
                params: ({ event }) => ({ message: `share save failed: ${event.reason}` }),
              },
            },
          },
          after: {
            SAVE_TIMEOUT: {
              target: 'waiting',
              actions: { type: 'warn', params: { message: 'share save timed out' } },
            },
          },
        },
      },
    },
    stopped: {
      type: 'final',
    },
  },
})
