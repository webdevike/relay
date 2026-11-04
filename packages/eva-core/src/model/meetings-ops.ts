// The Meetings page's reads and writes over work/meetings/<stem>.json (the records meeting-memory
// writes), shared by Relay desktop (local checkout) and the Relay Host (for the phone and thin
// clients). Writes go through EvaFs.
import type { EvaFs } from '../fs/eva-fs'
import { createPathQueue } from '../fs/path-queue'
import {
  dayKey,
  digest,
  displayTitle,
  pendingProposals,
  setProposalStatus,
  todoText,
  type Meeting,
} from './meetings'
import { readMeetingFile, readMeetings, readNotes } from './meetings-read'
import { parseProtocol } from './protocol'
import { appendTodoVia } from './todo-write'

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

export function meetingSummary(m: Meeting) {
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

export function meetingsList(root: string, now: Date) {
  const all = readMeetings(root)
  const d = digest(all, now)
  const ref = (m: Meeting) => ({ stem: m.stem, title: displayTitle(m) })
  return {
    now: now.getTime(),
    meetings: all.map(meetingSummary),
    digest: {
      recentCount: d.recent.length,
      waiting: d.waiting.map((w) => ({ ...ref(w.meeting), proposal: w.proposal })),
      out: d.out.map((o) => ({ text: o.text, date: o.date, ...ref(o.meeting) })),
      decisions: d.decisions.map((x) => ({ text: x.text, ...ref(x.meeting) })),
    },
  }
}

/** A record with its proposals and parsed notes; notes are read only inside `roots`. */
export function meetingsGet(root: string, stem: string, roots: string[]) {
  const found = readMeetingFile(root, stem)
  if (!found) return { meeting: null, notes: 'none' as const, protocol: null }
  const m = found.meeting
  const base = {
    ...meetingSummary(m),
    proposals: m.proposals,
    memorized: m.memorized.map(({ kind, text, p }) => ({ kind, text, p })),
  }
  if (m.notes === null || m.notes.trim() === '') {
    return { meeting: base, notes: 'none' as const, protocol: null }
  }
  const text = readNotes(m.notes, roots)
  if (text === null) return { meeting: base, notes: 'missing' as const, protocol: null }
  return { meeting: base, notes: 'ok' as const, protocol: parseProtocol(text) }
}

const acceptQueue = createPathQueue()
const SAFE_TAG = /^[a-z0-9][a-z0-9._-]*$/

/** Rewraps a status-edit failure into the codes the pages understand. */
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
  today: string,
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
    const added = await appendTodoVia(evaFs, root, tag, text, today)
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
