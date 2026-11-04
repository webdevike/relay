// The Meetings page. A Relay Host that runs Meetings (`welcome.features` has "meetings") answers
// everything: its recordings with their live transcripts and Astra, and the records it reads in its
// own Eva checkout, so the Mini, the MacBook and the phone show the same Meetings. Without one the
// records come from this Mac's checkout, as before, and there are no recordings.
import * as os from 'node:os'
import type { AstraItem as HostAstraItem } from '@relay/protocol'
import type { MeetingAstra } from '@evaos/contract'
import { readMeetingFile, resolveNotesPath } from '@evaos/eva-core/model/meetings-read'
import {
  meetingsAccept,
  meetingsDismiss,
  meetingsGet,
  meetingsList,
} from '@evaos/eva-core/model/meetings-ops'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import type { RelayFeatures, RelayFrames } from '../relay/client'
import { openAppLink, showNotice } from '../notice'
import { createHostMeetings, MEETINGS_FEATURE } from '../relay/host-meetings'
import { openPathChecked, type OpenPathOptions } from './open-path'
import { clockFor, evaFsFor } from './runtime'

export type NotesOpener = (abs: string, opts: OpenPathOptions) => Promise<void>

/** The notes path is resolved here from the stem; the renderer never supplies one. */
export async function meetingsOpenNotes(
  root: string,
  stem: string,
  roots: string[],
  open: (abs: string, opts: OpenPathOptions) => Promise<void>,
): Promise<{ opened: true }> {
  const found = readMeetingFile(root, stem)
  const notes = found?.meeting.notes ?? null
  if (notes === null || resolveNotesPath(notes, roots) === null) {
    throw Object.assign(new Error('This meeting has no notes file.'), { code: 'no-notes' })
  }
  await open(notes, { allowRoots: roots, requireExt: '.md' })
  return { opened: true }
}

/** Astra's session as a recording's page shows it. */
export function meetingAstra(
  item: Pick<HostAstraItem, 'turns' | 'working' | 'waiting' | 'error'>,
): MeetingAstra {
  return { turns: item.turns, working: item.working, waiting: item.waiting, error: item.error }
}

const noHost = (): Error =>
  Object.assign(new Error('Meetings need the Relay Host, and it is not connected.'), {
    code: 'relay-unavailable',
  })

export function registerMeetingsIpc(
  ctx: MainContext,
  relay: RelayFrames & RelayFeatures,
): () => void {
  const root = ctx.env.evaRoot
  const roots = [os.homedir(), root]
  const host = createHostMeetings(relay)
  const remote = (): boolean => relay.hostHas(MEETINGS_FEATURE)
  handle(ctx, 'meetings.list', async () => {
    if (!remote()) return { ...meetingsList(root, clockFor(ctx).now()), recordings: [] }
    const s = await host.list()
    return s as never
  })
  handle(ctx, 'meetings.get', async ({ stem }) =>
    remote()
      ? (((await host.req({ kind: 'get', stem })).detail ?? {
          meeting: null,
          notes: 'none',
          protocol: null,
        }) as never)
      : meetingsGet(root, stem, roots),
  )
  handle(ctx, 'meetings.openNotes', ({ stem }) =>
    meetingsOpenNotes(root, stem, roots, (abs, opts) => openPathChecked(ctx, abs, opts)),
  )
  handle(ctx, 'meetings.accept', async ({ stem, proposalId }) => {
    if (!remote())
      return meetingsAccept(root, evaFsFor(ctx), clockFor(ctx).today(), stem, proposalId)
    const r = await host.req({ kind: 'accept', stem, proposalId })
    return { todoId: String(r.todoId), tag: String(r.tag) }
  })
  handle(ctx, 'meetings.dismiss', async ({ stem, proposalId }) => {
    if (!remote()) return meetingsDismiss(root, evaFsFor(ctx), stem, proposalId)
    await host.req({ kind: 'dismiss', stem, proposalId })
    return { status: 'dismissed' as const }
  })
  handle(ctx, 'meetings.open', async ({ id }) => {
    if (!remote()) throw noHost()
    const { snapshot } = (await host.req({ kind: 'open', id })) as {
      snapshot: { recording: never; lines: never; astra: HostAstraItem | null; notes: never }
    }
    return {
      recording: snapshot.recording,
      lines: snapshot.lines,
      astra: snapshot.astra === null ? null : meetingAstra(snapshot.astra),
      notes: snapshot.notes,
    }
  })
  handle(ctx, 'meetings.ask', async ({ id, question }) => {
    if (!remote()) throw noHost()
    const { astra } = (await host.req({ kind: 'ask', id, question })) as { astra: HostAstraItem }
    return meetingAstra(astra)
  })
  handle(ctx, 'meetings.stop', async ({ id }) => {
    if (!remote()) throw noHost()
    await host.req({ kind: 'stop', id })
    return { stopped: true as const }
  })
  handle(ctx, 'meetings.discard', async ({ id }) => {
    if (!remote()) throw noHost()
    await host.req({ kind: 'discard', id })
    return { discarded: true as const }
  })
  // "Notes ready" once per recording this run of Relay saw being written up.
  const writingUp = new Set<string>()
  return relay.onFrame((f) => {
    if (f.t === 'meeting.recording') {
      const r = f.recording as { id: string; stage: string; title: string | null; app: string }
      if (r.stage !== 'done' && r.stage !== 'failed' && r.stage !== 'recording') writingUp.add(r.id)
      else if (r.stage === 'done' && writingUp.delete(r.id)) {
        showNotice(
          ctx,
          { title: 'Notes ready', body: r.title ?? `${r.app} call`, actions: [] },
          () => openAppLink(ctx, `relay://open/meetings?meeting=${encodeURIComponent(r.id)}`),
        )
      }
      emit(ctx, 'meetings.changed', { kind: 'recording', recording: f.recording as never })
    } else if (f.t === 'meeting.live' && typeof f.id === 'string')
      emit(ctx, 'meetings.changed', { kind: 'live', id: f.id, upsert: f.upsert as never })
    else if (f.t === 'meeting.astra' && typeof f.id === 'string')
      emit(ctx, 'meetings.changed', {
        kind: 'astra',
        id: f.id,
        astra: meetingAstra(f.item as HostAstraItem),
      })
    else if (f.t === 'meetings.state' || f.t === 'welcome')
      emit(ctx, 'meetings.changed', { kind: 'list' })
  })
}
