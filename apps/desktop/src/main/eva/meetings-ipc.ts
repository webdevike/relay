import * as os from 'node:os'
import * as path from 'node:path'
import {
  digest,
  displayTitle,
  pendingProposals,
  type Meeting,
} from '@evaos/eva-core/model/meetings'
import { readMeetingFile, readMeetings, readNotes } from '@evaos/eva-core/model/meetings-read'
import { parseProtocol } from '@evaos/eva-core/model/protocol'
import type { MainContext } from '../context'
import { handle } from '../ipc/handle'
import { openPathChecked, type OpenPathOptions } from './open-path'
import { clockFor } from './runtime'

type Clock = { now(): Date }
export type NotesOpener = (abs: string, opts: OpenPathOptions) => Promise<void>

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

function summary(m: Meeting) {
  return {
    stem: m.stem,
    title: displayTitle(m),
    start: m.start,
    skipped: m.skipped,
    skippedReason: m.skippedReason,
    pending: pendingProposals(m),
    hasNotes: m.notes !== null && m.notes.trim() !== '',
  }
}

export function meetingsList(root: string, clock: Clock) {
  const now = clock.now()
  const all = readMeetings(root)
  const d = digest(all, now)
  const ref = (m: Meeting) => ({ stem: m.stem, title: displayTitle(m) })
  return {
    now: now.getTime(),
    meetings: all.map(summary),
    digest: {
      recentCount: d.recent.length,
      waiting: d.waiting.map((w) => ({ ...ref(w.meeting), proposal: w.proposal })),
      out: d.out.map((o) => ({ text: o.text, date: o.date, ...ref(o.meeting) })),
      decisions: d.decisions.map((x) => ({ text: x.text, ...ref(x.meeting) })),
    },
  }
}

export function meetingsGet(root: string, stem: string) {
  const found = readMeetingFile(root, stem)
  if (!found) return { meeting: null, notes: 'none' as const, protocol: null }
  const m = found.meeting
  const base = {
    ...summary(m),
    proposals: m.proposals,
    memorized: m.memorized.map(({ kind, text, p }) => ({ kind, text, p })),
  }
  if (m.notes === null || m.notes.trim() === '') {
    return { meeting: base, notes: 'none' as const, protocol: null }
  }
  const text = readNotes(m.notes)
  if (text === null) return { meeting: base, notes: 'missing' as const, protocol: null }
  return { meeting: base, notes: 'ok' as const, protocol: parseProtocol(text) }
}

/** The notes path is resolved here from the stem; the renderer never supplies one. */
export async function meetingsOpenNotes(
  root: string,
  stem: string,
  roots: string[],
  open: (abs: string, opts: OpenPathOptions) => Promise<void>,
): Promise<{ opened: true }> {
  const found = readMeetingFile(root, stem)
  const notes = found?.meeting.notes ?? null
  if (notes === null || !path.isAbsolute(notes) || !notes.toLowerCase().endsWith('.md')) {
    throw coded('This meeting has no notes file.', 'no-notes')
  }
  await open(notes, { allowRoots: roots, requireExt: '.md' })
  return { opened: true }
}

export function registerMeetingsIpc(ctx: MainContext): void {
  const root = ctx.env.evaRoot
  handle(ctx, 'meetings.list', () => meetingsList(root, clockFor(ctx)))
  handle(ctx, 'meetings.get', ({ stem }) => meetingsGet(root, stem))
  handle(ctx, 'meetings.openNotes', ({ stem }) =>
    meetingsOpenNotes(root, stem, [os.homedir(), root], (abs, opts) =>
      openPathChecked(ctx, abs, opts),
    ),
  )
}
