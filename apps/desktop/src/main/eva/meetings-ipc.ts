import * as os from 'node:os'
import * as path from 'node:path'
import { createPathQueue, type EvaFs } from '@evaos/eva-core'
import {
  dayKey,
  digest,
  displayTitle,
  pendingProposals,
  setProposalStatus,
  todoText,
  type Meeting,
} from '@evaos/eva-core/model/meetings'
import { readMeetingFile, readMeetings, readNotes } from '@evaos/eva-core/model/meetings-read'
import { parseProtocol } from '@evaos/eva-core/model/protocol'
import type { MainContext } from '../context'
import { handle } from '../ipc/handle'
import { openPathChecked, type OpenPathOptions } from './open-path'
import { clockFor, evaFsFor } from './runtime'
import { appendTodoVia } from './todo-write'

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

const acceptQueue = createPathQueue()
const SAFE_TAG = /^[a-z0-9][a-z0-9._-]*$/

/** Rewraps a status-edit failure into the codes the renderer understands. */
function statusError(err: unknown): Error {
  const raw = (err as { code?: unknown } | null)?.code
  const code = typeof raw === 'string' ? raw : 'internal'
  const message = err instanceof Error ? err.message : 'The meeting record could not be updated.'
  return coded(message, code)
}

/**
 * Accept: todo first, then status, in Rust order. The proposed pre-check, the todo append and the
 * status write all run inside one per-stem queue, so a double accept cannot add two todos.
 */
export function meetingsAccept(
  root: string,
  evaFs: EvaFs,
  clock: { today(): string },
  stem: string,
  proposalId: string,
): Promise<{ todoId: string; tag: string }> {
  return acceptQueue.run(stem, async () => {
    const found = readMeetingFile(root, stem)
    if (!found) throw coded(`No meeting ${stem}.`, 'not-found')
    const proposal = found.meeting.proposals.find((p) => p.id === proposalId)
    if (!proposal) throw coded(`No proposal ${proposalId}.`, 'not-found')
    if (proposal.status !== 'proposed') {
      throw coded(`Proposal ${proposalId} is already ${proposal.status}.`, 'not-proposed')
    }
    const built = todoText(proposal, displayTitle(found.meeting), dayKey(found.meeting.start) ?? '')
    const tag = SAFE_TAG.test(built.tag) ? built.tag : 'eva'
    const text = built.text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
    const added = await appendTodoVia(evaFs, root, tag, text, clock.today())
    try {
      await evaFs.edit(
        'meeting-status',
        `work/meetings/${stem}.json`,
        (cur) => setProposalStatus(cur, proposalId, 'accepted'),
        { retryOnChange: true },
      )
    } catch (err) {
      // Already accepted (a retry saw our own or another write): the todo is in, so this is success.
      if ((err as { code?: unknown } | null)?.code === 'not-proposed')
        return { todoId: added.id, tag }
      throw coded(
        `Added ${added.id} but could not mark the proposal accepted. Reload the meeting.`,
        'partial-accept',
      )
    }
    return { todoId: added.id, tag }
  })
}

export function meetingsDismiss(
  root: string,
  evaFs: EvaFs,
  stem: string,
  proposalId: string,
): Promise<{ status: 'dismissed' }> {
  return acceptQueue.run(stem, async () => {
    if (!readMeetingFile(root, stem)) throw coded(`No meeting ${stem}.`, 'not-found')
    try {
      await evaFs.edit('meeting-status', `work/meetings/${stem}.json`, (cur) =>
        setProposalStatus(cur, proposalId, 'dismissed'),
      )
    } catch (err) {
      throw statusError(err)
    }
    return { status: 'dismissed' as const }
  })
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
  handle(ctx, 'meetings.accept', ({ stem, proposalId }) =>
    meetingsAccept(root, evaFsFor(ctx), clockFor(ctx), stem, proposalId),
  )
  handle(ctx, 'meetings.dismiss', ({ stem, proposalId }) =>
    meetingsDismiss(root, evaFsFor(ctx), stem, proposalId),
  )
}
