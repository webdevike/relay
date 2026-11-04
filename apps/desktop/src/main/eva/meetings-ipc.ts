import * as os from 'node:os'
import { readMeetingFile, resolveNotesPath } from '@evaos/eva-core/model/meetings-read'
import {
  meetingsAccept,
  meetingsDismiss,
  meetingsGet,
  meetingsList,
} from '@evaos/eva-core/model/meetings-ops'
import type { MainContext } from '../context'
import { handle } from '../ipc/handle'
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

export function registerMeetingsIpc(ctx: MainContext): void {
  const root = ctx.env.evaRoot
  const roots = [os.homedir(), root]
  handle(ctx, 'meetings.list', () => meetingsList(root, clockFor(ctx).now()))
  handle(ctx, 'meetings.get', ({ stem }) => meetingsGet(root, stem, roots))
  handle(ctx, 'meetings.openNotes', ({ stem }) =>
    meetingsOpenNotes(root, stem, roots, (abs, opts) => openPathChecked(ctx, abs, opts)),
  )
  handle(ctx, 'meetings.accept', ({ stem, proposalId }) =>
    meetingsAccept(root, evaFsFor(ctx), clockFor(ctx).today(), stem, proposalId),
  )
  handle(ctx, 'meetings.dismiss', ({ stem, proposalId }) =>
    meetingsDismiss(root, evaFsFor(ctx), stem, proposalId),
  )
}
