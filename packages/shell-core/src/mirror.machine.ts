import { assign, setup } from 'xstate'
import { diffEntries, patchEntries, sameValue, type Entries } from './mirror'

/**
 * One Relay Desktop's side of the window mirror (Relay Host `workspace.*`, entries in mirror.ts):
 * it sends what changes here and shows what changes on another Mac, last writer wins per key.
 * Pure: the desktop runtime (main/workspace/mirror.ts) sends the frames (`sendGet`, `sendPut`) and
 * shows remote changes (`applyEntries`). Docs: docs/state-machines/workspace-mirror.md.
 *
 * `synced` is the host's entries as far as this Mac knows; `local` what this Mac shows. A key where
 * they differ is a change of this Mac's the host does not have yet: it goes up, and a change of
 * another Mac's to that key in the meantime is not shown (this one lands after it on the host).
 * A remote change this Mac shows sets both, so the window's echo of it sends nothing back.
 */

export interface MirrorPut {
  rid: string
  set: Entries
  del: string[]
  /** Only for a host that holds nothing yet. */
  seed: boolean
}

export interface MirrorContext {
  /** This app launch's id: the host tags changes with it. */
  origin: string
  /** The host's rev as last heard; 0 before the first snapshot. */
  rev: number
  synced: Entries
  local: Entries
  /** The put waiting for its ack. */
  sent: MirrorPut | null
  /** Puts made so far, for rids. */
  seq: number
}

export type MirrorEvent =
  /** Connected to a host that mirrors the window. */
  | { type: 'host.up' }
  /** The connection dropped. */
  | { type: 'host.down' }
  /** `workspace.state`: every entry the host holds. */
  | { type: 'host.state'; rev: number; entries: Entries }
  /** `workspace.changed`: another desktop's put. */
  | { type: 'host.changed'; rev: number; origin: string; set: Entries; del: string[] }
  /** `workspace.ack` for a put. */
  | { type: 'host.ack'; rid: string; rev: number; applied: boolean }
  /** What this Mac shows now (all of it). */
  | { type: 'local.changed'; entries: Entries }

export interface MirrorInput {
  origin: string
  /** What this Mac showed at launch: taken as what the host had when it last saw this Mac. */
  entries: Entries
}

/** A put that gets no ack within this is lost: the mirror asks for the host's state again. */
export const MIRROR_ACK_MS = 15_000

/** This Mac's changes the host does not have yet: the keys where `local` and `synced` differ. */
export function pendingKeys(c: Pick<MirrorContext, 'synced' | 'local'>): Set<string> {
  const { set, del } = diffEntries(c.synced, c.local)
  return new Set([...Object.keys(set), ...del])
}

/** The host's `entries` as this Mac shows them: its pending keys keep their own values. */
function adopted(c: MirrorContext, entries: Entries): Entries {
  const keep = pendingKeys(c)
  const local: Entries = {}
  for (const [k, v] of Object.entries(entries)) if (!keep.has(k)) local[k] = v
  for (const k of keep) if (k in c.local) local[k] = c.local[k]
  return local
}

/** Another Mac's change as this Mac shows it: its pending keys keep their own values. */
function showable(c: MirrorContext, set: Entries, del: readonly string[]) {
  const mine = pendingKeys(c)
  const out: Entries = {}
  for (const [k, v] of Object.entries(set)) {
    if (!mine.has(k) && !sameValue(c.local[k], v)) out[k] = v
  }
  return { set: out, del: del.filter((k) => !mine.has(k) && k in c.local) }
}

type StateEvent = Extract<MirrorEvent, { type: 'host.state' }>
type ChangedEvent = Extract<MirrorEvent, { type: 'host.changed' }>
type AckEvent = Extract<MirrorEvent, { type: 'host.ack' }>

export const workspaceMirrorMachine = setup({
  types: {
    context: {} as MirrorContext,
    events: {} as MirrorEvent,
    input: {} as MirrorInput,
  },
  actions: {
    /** Runtime: send `workspace.get`. */
    sendGet: () => {},
    /** Runtime: send `workspace.put`. */
    sendPut: (_, _params: MirrorPut) => {},
    /** Runtime: show these remote changes (the window, the web pages, layout.json). */
    applyEntries: (_, _params: { set: Entries; del: string[] }) => {},
    takeLocal: assign({
      local: ({ context, event }) =>
        event.type === 'local.changed' ? event.entries : context.local,
    }),
    forgetPut: assign({ sent: null }),
    /** The host's whole state stands in for this Mac's view of it; pending changes stay. */
    adopt: assign(({ context, event }) => {
      const e = event as StateEvent
      return { rev: e.rev, synced: e.entries, local: adopted(context, e.entries), sent: null }
    }),
    /** Every local entry goes to a host that holds nothing. */
    seed: assign(({ context }) => ({
      rev: 0,
      synced: {},
      seq: context.seq + 1,
      sent: {
        rid: `${context.origin}-${context.seq + 1}`,
        set: context.local,
        del: [],
        seed: true,
      },
    })),
    takeChange: assign(({ context, event }) => {
      const e = event as ChangedEvent
      const shown = showable(context, e.set, e.del)
      return {
        rev: e.rev,
        synced: patchEntries(context.synced, e.set, e.del),
        local: patchEntries(context.local, shown.set, shown.del),
      }
    }),
  },
  guards: {
    hasPending: ({ context }) => pendingKeys(context).size > 0,
    isEmptyHost: ({ event }) =>
      event.type === 'host.state' && event.rev === 0 && Object.keys(event.entries).length === 0,
    isOurAck: ({ context, event }) => event.type === 'host.ack' && event.rid === context.sent?.rid,
    isRefusedSeed: ({ context, event }) =>
      event.type === 'host.ack' && !event.applied && context.sent?.seed === true,
    isNextRev: ({ context, event }) =>
      event.type === 'host.changed' && event.rev === context.rev + 1,
    isOldRev: ({ context, event }) => event.type === 'host.changed' && event.rev <= context.rev,
  },
  delays: { ackTimeout: MIRROR_ACK_MS },
}).createMachine({
  id: 'workspaceMirror',
  context: ({ input }) => ({
    origin: input.origin,
    rev: 0,
    synced: input.entries,
    local: input.entries,
    sent: null,
    seq: 0,
  }),
  initial: 'offline',
  on: {
    'host.down': { target: '.offline', actions: 'forgetPut' },
    'local.changed': { actions: 'takeLocal' },
    // The host's whole state (a join, or a seed it refused): a host that holds nothing takes this
    // Mac's entries; else this Mac shows the host's, keeping its own changes the host lacks.
    'host.state': [
      { guard: 'isEmptyHost', target: '.live.sending', actions: 'seed' },
      {
        target: '.live',
        actions: [
          {
            type: 'applyEntries',
            params: ({ context, event }) =>
              diffEntries(context.local, adopted(context, (event as StateEvent).entries)),
          },
          'adopt',
        ],
      },
    ],
  },
  states: {
    /** No host that mirrors the window: changes here wait in `local`. */
    offline: {
      on: {
        'host.up': { target: 'joining', actions: 'sendGet' },
        // A state that was on its way when the connection dropped: not adopted.
        'host.state': { actions: [] },
      },
    },
    /** Asked for the host's entries (`host.state` moves on); changes here keep waiting. */
    joining: {},
    live: {
      initial: 'idle',
      on: {
        'host.changed': [
          { guard: 'isOldRev' },
          {
            guard: 'isNextRev',
            actions: [
              {
                type: 'applyEntries',
                params: ({ context, event }) =>
                  showable(context, (event as ChangedEvent).set, (event as ChangedEvent).del),
              },
              'takeChange',
            ],
          },
          // A rev skipped: something was missed, so the host's whole state comes again.
          { target: 'joining', actions: ['forgetPut', 'sendGet'] },
        ],
      },
      states: {
        idle: {
          always: { guard: 'hasPending', target: 'sending' },
        },
        /** A put is out; the next one waits for its ack. */
        sending: {
          entry: [
            assign(({ context }) => {
              if (context.sent !== null) return {}
              const { set, del } = diffEntries(context.synced, context.local)
              return {
                seq: context.seq + 1,
                sent: { rid: `${context.origin}-${context.seq + 1}`, set, del, seed: false },
              }
            }),
            { type: 'sendPut', params: ({ context }) => context.sent! },
          ],
          after: {
            ackTimeout: { target: '#workspaceMirror.joining', actions: ['forgetPut', 'sendGet'] },
          },
          on: {
            'host.ack': [
              // Another Mac seeded first: its state follows this ack and this Mac adopts all of it.
              {
                guard: 'isRefusedSeed',
                target: '#workspaceMirror.joining',
                actions: assign(({ context }) => ({ sent: null, synced: context.local })),
              },
              {
                guard: 'isOurAck',
                target: 'idle',
                // A refused put (over the host's size cap) counts as sent: sending it again would
                // be refused again.
                actions: assign(({ context, event }) => ({
                  sent: null,
                  rev: Math.max(context.rev, (event as AckEvent).rev),
                  synced: patchEntries(context.synced, context.sent!.set, context.sent!.del),
                })),
              },
            ],
          },
        },
      },
    },
  },
})
