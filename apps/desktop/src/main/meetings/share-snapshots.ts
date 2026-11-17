// Runs share-snapshots.machine.ts for one recording: helper events go in, helper commands and the
// host's `meeting.share` frame come out. No electron (and nothing that pulls it in), so a bun proof
// script can drive a real meeting helper with it:
//
//   const child = spawn(helperPath, ['serve', '--spool', dir], { stdio: ['pipe', 'pipe', 'inherit'] })
//   const shots = createShareSnapshots({
//     id, percent: 6,
//     sendHelper: (cmd) => child.stdin.write(`${JSON.stringify(cmd)}\n`),
//     sendFrame: (frame) => console.log(frame),
//   })
//   // for each stdout line: const ev = parseShareEvent(line); if (ev) shots.heard(ev)
//
// meetings-capture.ts does the same for every recording the helper reports.
import { createActor, type ActorOptions } from 'xstate'
import { z } from 'zod'
import type { MeetingShare } from '@relay/protocol'
import { shareSnapshotsMachine, type ShareSnapshotsEvent } from './share-snapshots.machine'

/** The helper's screen-share events (apps/meetings-capture Daemon.swift), one per stdout line. */
export const SHARE_HELPER_EVENTS = [
  z.object({
    ev: z.literal('share'),
    id: z.string(),
    state: z.enum(['on', 'off']),
    permission: z.boolean(),
  }),
  z.object({ ev: z.literal('share.sampled'), id: z.string(), seq: z.number(), hash: z.string() }),
  z.object({
    ev: z.literal('share.sample.failed'),
    id: z.string(),
    seq: z.number(),
    reason: z.string(),
  }),
  z.object({ ev: z.literal('share.saved'), id: z.string(), seq: z.number(), n: z.number() }),
  z.object({
    ev: z.literal('share.save.failed'),
    id: z.string(),
    seq: z.number(),
    reason: z.string(),
  }),
] as const
const ShareHelperEvent = z.discriminatedUnion('ev', [...SHARE_HELPER_EVENTS])
export type ShareHelperEvent = z.infer<typeof ShareHelperEvent>

/** One helper stdout line as a share event, or null when it is something else. */
export function parseShareEvent(line: string): ShareHelperEvent | null {
  try {
    const r = ShareHelperEvent.safeParse(JSON.parse(line))
    return r.success ? r.data : null
  } catch {
    return null
  }
}

export type ShareCommand = { cmd: 'share.sample' | 'share.save'; id: string; seq: number }
export type ShareFrame = { t: 'meeting.share'; id: string; state: MeetingShare }
/** What the machine's delays run on (a SimulatedClock in tests). */
export type ShareClock = NonNullable<ActorOptions<typeof shareSnapshotsMachine>['clock']>

export interface ShareSnapshotsDeps {
  /** The recording. */
  id: string
  /** `meetings.snapshotChange`: percent of the hash that must change for a new shot. */
  percent: number
  /** Writes a command line to the helper. */
  sendHelper: (cmd: ShareCommand) => void
  /** Sends a frame to the host. */
  sendFrame: (frame: ShareFrame) => void
  log?: (msg: string) => void
  clock?: ShareClock
}

export interface ShareSnapshots {
  /** A share event from the helper; another recording's are ignored. */
  heard(ev: ShareHelperEvent): void
  /** The setting changed. */
  setPercent(percent: number): void
  /** A fresh host connection: says again that someone shares (a host that restarted forgot). */
  resend(): void
  /** The recording stopped: no command or frame follows. */
  stop(): void
}

function machineEvent(ev: ShareHelperEvent): ShareSnapshotsEvent {
  switch (ev.ev) {
    case 'share':
      return ev.state === 'on'
        ? { type: 'share.on', permission: ev.permission }
        : { type: 'share.off' }
    case 'share.sampled':
      return { type: 'share.sampled', seq: ev.seq, hash: ev.hash }
    case 'share.sample.failed':
      return { type: 'share.sample.failed', seq: ev.seq, reason: ev.reason }
    case 'share.saved':
      return { type: 'share.saved', seq: ev.seq, n: ev.n }
    case 'share.save.failed':
      return { type: 'share.save.failed', seq: ev.seq, reason: ev.reason }
  }
}

export function createShareSnapshots(deps: ShareSnapshotsDeps): ShareSnapshots {
  const { id } = deps
  const machine = shareSnapshotsMachine.provide({
    actions: {
      askSample: (_, { seq }) => deps.sendHelper({ cmd: 'share.sample', id, seq }),
      askSave: (_, { seq }) => deps.sendHelper({ cmd: 'share.save', id, seq }),
      reportShare: (_, { state }) => deps.sendFrame({ t: 'meeting.share', id, state }),
      warn: (_, { message }) => deps.log?.(`meetings: ${id}: ${message}`),
    },
  })
  const actor = createActor(machine, {
    input: { percent: deps.percent },
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
  }).start()
  // A stopped actor would only warn about every event sent to it.
  const live = (): boolean => actor.getSnapshot().status === 'active'
  return {
    heard(ev) {
      if (ev.id === id && live()) actor.send(machineEvent(ev))
    },
    setPercent(percent) {
      if (live()) actor.send({ type: 'share.threshold', percent })
    },
    resend() {
      const s = actor.getSnapshot()
      if (s.status !== 'active') return
      if (s.matches('sharing')) deps.sendFrame({ t: 'meeting.share', id, state: 'sharing' })
      else if (s.matches('blocked'))
        deps.sendFrame({ t: 'meeting.share', id, state: 'no-permission' })
    },
    stop() {
      // `share.stop` tells the host nobody shares any more (when it heard otherwise) and lands in
      // the final state, which ends the actor and its timers.
      if (live()) actor.send({ type: 'share.stop' })
      actor.stop()
    },
  }
}
