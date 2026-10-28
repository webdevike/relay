// The context popover's snapshot: pins on top, then what is live here (a code chat's branch, PR,
// checks, reviews, diff and ledger stage) and the tasks here or everywhere, grouped like OpenDuet's
// Tasks by what each needs from Isaac: Needs input, Ready for review, Working, Resolved (folded).
// Pure over its deps: every slow source (gh, git) comes from a background cache, never awaited here.
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  Assistant,
  ContextAction,
  ContextOpen,
  ContextQuery,
  ContextRow,
  ContextSection,
  ContextSnapshot,
  ContextTone,
  ExperimentRow,
  PinRef,
} from '@evaos/contract'
import type { JobSummary } from '@evaos/eva-core/model/jobs-read'
import { keysIn, pathWithin, type Place } from '@evaos/chat-core/work'
import { sessionId } from '@evaos/chat-core/session-id'
import type { RelaySession } from '../relay/feed'
import type { PrFacts } from './gh'
import { canCommitPush, type GitFacts } from './git'
import { itemFinished, itemReady, type Item } from './items'
import {
  ACTIVE_MS,
  assistantNotes,
  assistantSessions,
  sessionTitle,
  subagentsOf,
  type LineCache,
  type Worker,
} from './sessions'

export const DAY_MS = 86_400_000
/** Lists longer than this show their first rows and the total in the section header. */
export const SECTION_ROWS = 5

export interface SnapshotDeps {
  evaRoot: string
  now: () => number
  items: () => Item[]
  lines: LineCache
  pins: () => PinRef[]
  /** Where a chat session works; null when unreadable. Throws for a file outside the sessions dirs. */
  placeOf: (file: string) => Place | null
  assistants: () => Assistant[]
  relaySessions: () => ReadonlyMap<string, RelaySession> | null
  /** The session file of omp session `id` in the chat list's dirs, or null. */
  sessionFile: (id: string) => string | null
  /** Cached facts, refreshed in the background (hot: sooner). */
  pr: (repo: string, number: number, hot: boolean) => PrFacts | null
  git: (dir: string, base: string | null, hot: boolean) => GitFacts | null
  jobs: () => JobSummary[]
  experiments: () => Promise<ExperimentRow[]>
}

type RowInit = Pick<ContextRow, 'id' | 'icon' | 'title'> & Partial<ContextRow>

function row(r: RowInit): ContextRow {
  return {
    tone: 'default',
    mono: false,
    sub: null,
    meta: null,
    time: null,
    pill: null,
    diff: null,
    progress: null,
    pin: null,
    open: null,
    ...r,
  }
}

/** `noahchampoux-ecardsystems` → `noahchampoux`: the person, not the org suffix. */
export function shortLogin(login: string): string {
  return login.split('-')[0] || login
}

export function prPill(pr: PrFacts | null): ContextRow['pill'] {
  if (pr === null) return null
  if (pr.state === 'MERGED') return { label: 'Merged', tone: 'info' }
  if (pr.state === 'CLOSED') return { label: 'Closed', tone: 'default' }
  if (pr.decision === 'CHANGES_REQUESTED') return { label: 'Changes requested', tone: 'warning' }
  if (pr.draft) return { label: 'Draft', tone: 'default' }
  if (pr.decision === 'APPROVED') return { label: 'Approved', tone: 'success' }
  return { label: 'In review', tone: 'info' }
}

function prTone(pr: PrFacts | null): ContextTone {
  if (pr?.state === 'CLOSED') return 'default'
  if (pr?.state === 'MERGED') return 'info'
  return 'success'
}

function checksRow(pr: PrFacts): ContextRow | null {
  const c = pr.checks
  if (c.total === 0) return null
  const base = {
    id: 'checks',
    title: 'Checks',
    open: { kind: 'url' as const, url: `${pr.url}/checks` },
  }
  if (c.failed > 0) {
    return row({
      ...base,
      icon: 'checks-failed',
      tone: 'danger',
      meta: `${c.failed} of ${c.total} failing`,
    })
  }
  if (c.pending > 0) {
    return row({
      ...base,
      icon: 'checks-pending',
      tone: 'info',
      meta: `${c.pending} of ${c.total} running`,
    })
  }
  return row({ ...base, icon: 'checks', tone: 'success', meta: `${c.passed} of ${c.total} passed` })
}

const REVIEW_TEXT: Record<string, { verb: string; pill: ContextRow['pill'] }> = {
  CHANGES_REQUESTED: {
    verb: 'requested changes',
    pill: { label: 'Changes requested', tone: 'warning' },
  },
  APPROVED: { verb: 'approved', pill: { label: 'Approved', tone: 'success' } },
  COMMENTED: { verb: 'commented', pill: null },
}

function workerRow(w: Worker, owner: string | null): ContextRow {
  const open: ContextRow['open'] =
    w.session === w.file
      ? { kind: 'chat', file: w.file }
      : { kind: 'subagent', session: w.session, file: w.file, name: w.name }
  const pin: PinRef = { kind: 'session', file: w.file, title: w.name.slice(0, 200) }
  if (w.running) {
    return row({
      id: `worker:${w.file}`,
      icon: 'running',
      tone: 'info',
      title: w.name,
      sub: [owner, w.line].filter(Boolean).join(': ') || null,
      time: { at: w.at, style: 'elapsed' },
      pin,
      open,
    })
  }
  return row({
    id: `worker:${w.file}`,
    icon: 'done',
    tone: 'success',
    title: w.name,
    sub: [owner, w.line].filter(Boolean).join(': ') || null,
    time: { at: w.at, style: 'clock' },
    pin,
    open,
  })
}

/**
 * A work item whose move is Isaac's: built work to look at (Ready for review: its PR opens, else
 * its ledger), or a question for him (Needs input: its ledger opens). Anyone else's move: its ledger.
 */
function itemRow(item: Item, id = `item:${item.key}`): ContextRow {
  const mine = item.move === 'isaac'
  const ready = mine && itemReady(item)
  // A ticket key is short and scannable; a slug key would only crowd the line.
  const key = item.title && /^[A-Z]+-\d+$/.test(item.key) ? item.key : null
  return row({
    id,
    icon: ready ? 'ready' : mine ? 'needs' : 'item',
    tone: ready ? 'success' : mine ? 'warning' : 'default',
    title: item.title ?? item.key,
    sub: [key, item.next].filter(Boolean).join(': ') || null,
    time: { at: item.updatedMs, style: 'day' },
    pin: { kind: 'item', key: item.key },
    open: ready && item.pr ? { kind: 'url', url: item.pr.url } : { kind: 'files', path: item.file },
  })
}

/** Relay's sessions blocked on Isaac (a question it asked, a tool waiting for approval), by id. */
function blockedSessions(
  relay: ReadonlyMap<string, RelaySession> | null,
): Map<string, RelaySession> {
  return new Map(
    [...(relay?.values() ?? [])]
      .filter((s) => s.status === 'waiting' || s.status === 'needs_permission')
      .map((s) => [s.id, s]),
  )
}

/** A session blocked on Isaac: who, then what it waits on (its question, or the tool to approve). */
function waitingRow(s: RelaySession, title: string, open: ContextOpen | null): ContextRow {
  return row({
    id: `waiting:${s.id}`,
    icon: 'needs',
    tone: 'warning',
    title,
    sub:
      s.status === 'needs_permission'
        ? `Approve ${s.detail ?? 'a tool call'}`
        : (s.activity ?? 'Asked you something'),
    time: s.activityAt === null ? null : { at: s.activityAt, style: 'elapsed' },
    open,
  })
}

function jobRow(j: JobSummary, now: number): ContextRow {
  const running = j.runState === 'running'
  return row({
    id: `job:${j.name}`,
    icon: running ? 'running' : j.runState === 'failed' ? 'failed' : 'job',
    tone: running
      ? 'info'
      : j.runState === 'failed'
        ? 'danger'
        : j.runState === 'ok'
          ? 'success'
          : 'default',
    title: j.runState === 'failed' ? `${j.name} failed` : j.name,
    sub: j.runNote ?? j.description,
    time:
      j.lastRunAt === null
        ? null
        : { at: j.lastRunAt, style: running && now - j.lastRunAt < DAY_MS ? 'elapsed' : 'clock' },
    pin: { kind: 'job', name: j.name },
    open: { kind: 'jobs' },
  })
}

const EXPERIMENT_STATUS: Record<ExperimentRow['status'], string> = {
  planned: 'Planned',
  running: 'Running',
  pass: 'Passed',
  fail: 'Failed',
  inconclusive: 'Inconclusive',
}

function experimentRow(e: ExperimentRow): ContextRow {
  const running = e.status === 'running'
  const p = e.progress
  const progress =
    running && p && p.planned ? { done: Math.min(p.done, p.planned), total: p.planned } : null
  return row({
    id: `experiment:${e.id}`,
    icon: 'experiment',
    tone: e.status === 'pass' ? 'success' : e.status === 'fail' ? 'danger' : 'default',
    title: e.title,
    // Test Bench's "running" spans rounds; only a live status.json carries progress.
    sub: [
      running && !p ? 'In progress' : EXPERIMENT_STATUS[e.status],
      e.round ? `round ${e.round}` : null,
    ]
      .filter(Boolean)
      .join(', '),
    meta: p ? (p.planned ? `${p.done} / ${p.planned}` : `${p.done} runs`) : null,
    progress,
    pin: { kind: 'experiment', id: e.id },
    open: { kind: 'experiment', id: e.id },
  })
}

/** A section of at most `limit` rows; null when it has none. */
function section(
  id: string,
  title: string,
  rows: ContextRow[],
  meta: string | null,
  limit = SECTION_ROWS,
  fold = false,
): ContextSection | null {
  if (rows.length === 0) return null
  return { id, title, meta, fold, rows: rows.slice(0, limit) }
}

/** A count for a section header: `3`, or `5 of 23` when the section shows only the first rows. */
function countOf(rows: readonly ContextRow[]): string {
  return rows.length > SECTION_ROWS ? `${SECTION_ROWS} of ${rows.length}` : `${rows.length}`
}

const nonNull = <T>(v: T | null): v is T => v !== null

/**
 * Everything delegated, by what it needs from Isaac (OpenDuet's Tasks): blocked on his answer,
 * built and waiting for his look, still running, and finished (folded away).
 */
interface Tasks {
  needs: ContextRow[]
  review: ContextRow[]
  working: ContextRow[]
  resolved: ContextRow[]
}

/** The task groups, top to bottom; Resolved starts folded and only a failure keeps its color. */
function taskSections(t: Tasks): ContextSection[] {
  const resolved = t.resolved.map((r) =>
    r.tone === 'danger' ? r : { ...r, tone: 'default' as const },
  )
  return [
    section('needs', 'Needs input', t.needs, countOf(t.needs)),
    section('review', 'Ready for review', t.review, countOf(t.review)),
    section('working', 'Working', t.working, countOf(t.working)),
    section('resolved', 'Resolved', resolved, countOf(resolved), SECTION_ROWS, true),
  ].filter(nonNull)
}

/** `2 working, 1 needs input, 3 ready for review`, without the empty groups. */
function taskSummary(t: Tasks): string[] {
  const n = t.needs.length
  return [
    t.working.length > 0 ? `${t.working.length} working` : null,
    n > 0 ? `${n} ${n === 1 ? 'needs' : 'need'} input` : null,
    t.review.length > 0 ? `${t.review.length} ready for review` : null,
  ].filter(nonNull)
}

/** Isaac's open asks split by what he owes: a look at built work, or an answer. */
function askGroups(open: readonly Item[]): { review: ContextRow[]; needs: ContextRow[] } {
  return {
    review: open.filter((i) => itemReady(i)).map((i) => itemRow(i)),
    needs: open.filter((i) => !itemReady(i)).map((i) => itemRow(i)),
  }
}

/** A pinned chat or subagent: running until its `.md` appears (subagents) or it goes quiet (chats). */
function sessionRow(
  ref: Extract<PinRef, { kind: 'session' }>,
  now: number,
  lines: LineCache,
): ContextRow {
  const id = `pin:session:${ref.file}`
  let st: fs.Stats
  try {
    st = fs.statSync(ref.file)
  } catch {
    return row({ id, icon: 'chat', title: ref.title, sub: 'Transcript is gone', pin: ref })
  }
  const parent = `${path.dirname(ref.file)}.jsonl`
  const subagent = fs.existsSync(parent)
  const done = subagent
    ? fs.existsSync(ref.file.replace(/\.jsonl$/, '.md'))
    : now - st.mtimeMs > ACTIVE_MS
  const w: Worker = {
    name: ref.title,
    file: ref.file,
    session: subagent ? parent : ref.file,
    running: !done && now - st.mtimeMs < DAY_MS,
    at: done ? st.mtimeMs : st.birthtimeMs || st.mtimeMs,
    line: lines.line(ref.file, st),
  }
  const r = workerRow(w, null)
  return {
    ...r,
    id,
    title: ref.title,
    icon: w.running ? 'running' : 'chat',
    tone: w.running ? 'info' : 'default',
  }
}

interface Ctx {
  d: SnapshotDeps
  now: number
  hot: boolean
  items: Item[]
  jobs: JobSummary[]
  experiments: ExperimentRow[]
}

function pinRow(c: Ctx, ref: PinRef): ContextRow {
  switch (ref.kind) {
    case 'pr': {
      const pr = c.d.pr(ref.repo, ref.number, c.hot)
      const item = c.items.find((i) => i.pr?.repo === ref.repo && i.pr.number === ref.number)
      return row({
        id: `pin:pr:${ref.repo}#${ref.number}`,
        icon: 'pr',
        tone: prTone(pr),
        title: `#${ref.number} ${pr?.title ?? item?.title ?? ref.repo}`,
        sub: item?.next ?? ref.repo,
        pill: prPill(pr),
        pin: ref,
        open: { kind: 'url', url: pr?.url ?? `https://github.com/${ref.repo}/pull/${ref.number}` },
      })
    }
    case 'item': {
      const item = c.items.find((i) => i.key === ref.key)
      if (!item)
        return row({
          id: `pin:item:${ref.key}`,
          icon: 'item',
          title: ref.key,
          sub: 'Ledger not found',
          pin: ref,
        })
      return { ...itemRow(item, `pin:item:${ref.key}`), meta: item.stage, time: null }
    }
    case 'experiment': {
      const e = c.experiments.find((x) => x.id === ref.id)
      if (!e)
        return row({
          id: `pin:experiment:${ref.id}`,
          icon: 'experiment',
          title: ref.id,
          sub: 'Not found in Test Bench',
          pin: ref,
        })
      return { ...experimentRow(e), id: `pin:experiment:${ref.id}` }
    }
    case 'job': {
      const j = c.jobs.find((x) => x.name === ref.name)
      if (!j)
        return row({
          id: `pin:job:${ref.name}`,
          icon: 'job',
          title: ref.name,
          sub: 'Job not found',
          pin: ref,
        })
      return { ...jobRow(j, c.now), id: `pin:job:${ref.name}`, title: j.name }
    }
    case 'session':
      return sessionRow(ref, c.now, c.d.lines)
  }
}

interface Here {
  kind: ContextSnapshot['kind']
  button: ContextSnapshot['button']
  sections: ContextSection[]
  actions: ContextAction[]
}

/**
 * The work item a chat is on: the one whose worktree holds its active worktree, else its folder,
 * else the first whose key a ticket key in its title names (`ENG-6524 auto-work`).
 */
export function itemAt(
  items: readonly Item[],
  place: Place | null,
  title: string | null,
): Item | null {
  for (const dir of [place?.active ?? null, place?.cwd ?? null]) {
    if (dir === null) continue
    const hit = items.find((i) => i.worktree !== null && pathWithin(dir, i.worktree))
    if (hit) return hit
  }
  for (const key of title === null ? [] : keysIn(title)) {
    const hit = items.find((i) => i.key === key)
    if (hit) return hit
  }
  return null
}

const SHARED_BRANCHES = ['main', 'master', 'develop', 'dev']

function chatHere(c: Ctx, file: string): Here {
  const place = c.d.placeOf(file)
  const item = itemAt(c.items, place, sessionTitle(file))
  const worktree =
    place?.active ??
    (item?.worktree && fs.existsSync(item.worktree) ? item.worktree : null) ??
    (place?.cwdBranch && !place.eva && !SHARED_BRANCHES.includes(place.cwdBranch)
      ? place.cwd
      : null)
  const workers = subagentsOf(file, c.now, c.d.lines)
  const running = workers.filter((w) => w.running)
  const relay = [...(c.d.relaySessions()?.values() ?? [])].find((s) => s.id === sessionId(file))
  const waiting = relay?.status === 'waiting' || relay?.status === 'needs_permission'
  const working = relay?.status === 'working'
  // A code chat's work item is already its stage row under This chat, so it is not a task too.
  const plain = worktree === null && item === null
  const tasks: Tasks = {
    needs: relay && waiting ? [waitingRow(relay, sessionTitle(file) ?? 'This chat', null)] : [],
    review: [],
    working: running.map((w) => workerRow(w, null)),
    resolved: workers
      .filter((w) => !w.running && c.now - w.at < DAY_MS)
      .map((w) => workerRow(w, null)),
  }

  if (plain) {
    const n = running.length
    const parts = taskSummary(tasks)
    return {
      kind: 'chat',
      button: {
        icon: 'activity',
        label: n > 0 ? `${n} running` : null,
        dot: waiting ? 'needs' : n > 0 || working ? 'running' : null,
        summary:
          parts.length > 0 ? `This chat: ${parts.join(', ')}` : 'Nothing running in this chat',
      },
      sections: taskSections(tasks),
      actions: [],
    }
  }

  const prRef = item?.pr ?? null
  const pr = prRef ? c.d.pr(prRef.repo, prRef.number, c.hot) : null
  const git = worktree ? c.d.git(worktree, pr?.base ?? null, c.hot) : null
  const branch = git?.branch ?? place?.activeBranch ?? item?.branch ?? null
  const rows: ContextRow[] = []
  if (branch !== null || worktree !== null) {
    const changes = [
      git && git.dirty > 0 ? `${git.dirty} uncommitted` : null,
      git && git.ahead > 0 ? `${git.ahead} to push` : null,
      git && git.behind > 0 ? `${git.behind} behind` : null,
      git?.conflicted ? 'conflicts' : null,
    ].filter(nonNull)
    rows.push(
      row({
        id: 'branch',
        icon: 'branch',
        title: branch ?? (worktree ? path.basename(worktree) : ''),
        mono: branch !== null,
        sub: changes.length > 0 ? changes.join(', ') : null,
        meta: pr?.base ?? null,
        open: worktree ? { kind: 'files', path: worktree } : null,
      }),
    )
  }
  if (prRef) {
    rows.push(
      row({
        id: 'pr',
        icon: 'pr',
        tone: prTone(pr),
        title: `PR #${prRef.number}`,
        sub: pr?.title ?? null,
        // A reviewer's row carries "Changes requested"; the PR row keeps its own state.
        pill:
          pr?.decision === 'CHANGES_REQUESTED' &&
          pr.reviews.some((r) => r.state === 'CHANGES_REQUESTED')
            ? prPill({ ...pr, decision: null })
            : prPill(pr),
        pin: { kind: 'pr', repo: prRef.repo, number: prRef.number },
        open: { kind: 'url', url: pr?.url ?? prRef.url },
      }),
    )
  }
  if (pr) {
    const checks = checksRow(pr)
    if (checks) rows.push(checks)
    for (const r of pr.reviews) {
      const text = REVIEW_TEXT[r.state]
      if (!text) continue
      rows.push(
        row({
          id: `review:${r.login}`,
          icon: 'review',
          title: `${shortLogin(r.login)} ${text.verb}`,
          pill: text.pill,
          time: r.at === null || text.pill ? null : { at: r.at, style: 'clock' },
          open: { kind: 'url', url: pr.url },
        }),
      )
    }
  }
  const diff = pr ? { add: pr.additions, del: pr.deletions } : (git?.diff ?? null)
  if (diff && diff.add + diff.del > 0)
    rows.push(row({ id: 'diff', icon: 'diff', title: 'Changes', diff }))
  if (item) {
    rows.push(
      row({
        id: 'stage',
        icon: 'stage',
        title: item.stage ?? 'No stage yet',
        sub: item.next,
        pill:
          item.move === 'isaac'
            ? { label: 'Your move', tone: 'warning' }
            : item.move
              ? {
                  label: `${item.move[0]!.toUpperCase()}${item.move.slice(1)}'s move`,
                  tone: 'default',
                }
              : null,
        pin: { kind: 'item', key: item.key },
        open: { kind: 'files', path: item.file },
      }),
    )
  }

  const actions: ContextAction[] = []
  const url = pr?.url ?? prRef?.url
  if (url) actions.push({ id: 'open-pr', url })
  if (worktree) actions.push({ id: 'open-files', path: worktree })
  if (git && worktree && canCommitPush(git, pr ? pr.state === 'OPEN' : null)) {
    const what =
      git.dirty > 0
        ? `Commit the ${git.dirty} uncommitted ${git.dirty === 1 ? 'change' : 'changes'} in ${worktree} with a clear message, then push ${git.branch}`
        : `Push the ${git.ahead} local ${git.ahead === 1 ? 'commit' : 'commits'} on ${git.branch} in ${worktree}`
    actions.push({
      id: 'commit-push',
      prompt: `${what} to origin. Stop and tell me instead if the push is rejected or would need a force-push.`,
    })
  }

  const changesRequested = pr?.decision === 'CHANGES_REQUESTED'
  const failing = (pr?.checks.failed ?? 0) > 0
  const busy = running.length > 0 || working || (pr?.checks.pending ?? 0) > 0
  const checkMeta = pr ? checksRow(pr)?.meta : null
  const facts = [
    prPill(pr)?.label.toLowerCase(),
    checkMeta ? `checks ${checkMeta}` : null,
    item?.move === 'isaac' ? 'your move' : null,
  ].filter(Boolean)
  const name = prRef ? `PR #${prRef.number}` : (item?.key ?? branch ?? 'This chat')
  return {
    kind: 'code',
    button: {
      icon: prRef ? 'pr' : 'branch',
      label: prRef ? `#${prRef.number}` : (item?.key ?? branch),
      dot:
        waiting || changesRequested || item?.move === 'isaac'
          ? 'needs'
          : failing
            ? 'failing'
            : busy
              ? 'running'
              : null,
      summary: facts.length > 0 ? `${name}: ${facts.join(', ')}` : name,
    },
    sections: [
      section('here', 'This chat', rows, item?.key ?? null, rows.length),
      ...taskSections(tasks),
    ].filter(nonNull),
    actions,
  }
}

/** Who owns each work item: the assistant whose scope names its workspace, else one whose notes name its key. */
export function itemOwners(
  items: readonly Item[],
  agents: ReadonlyArray<{ id: string; scope: string; notes: string }>,
): Map<string, string> {
  const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const owners = new Map<string, string>()
  for (const item of items) {
    const ws = item.workspace ? squash(item.workspace) : ''
    const byScope = ws === '' ? undefined : agents.find((a) => squash(a.scope).includes(ws))
    const keyRe = new RegExp(
      `(^|[^A-Za-z0-9-])${item.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9-])`,
    )
    const owner = byScope ?? agents.find((a) => keyRe.test(a.notes))
    if (owner) owners.set(item.key, owner.id)
  }
  return owners
}

/** Isaac's open asks: items whose move is his, newest first. */
function asks(items: readonly Item[], now: number, maxAgeMs: number): Item[] {
  return items
    .filter((i) => i.move === 'isaac' && !itemFinished(i) && now - i.updatedMs < maxAgeMs)
    .sort((a, b) => b.updatedMs - a.updatedMs)
}

/** An assistant's own thread blocked on Isaac: Relay's word, else the registry's (Relay down). */
function threadWaitingRow(
  a: Assistant,
  blocked: ReadonlyMap<string, RelaySession>,
): ContextRow | null {
  const open: ContextOpen | null = a.file ? { kind: 'chat', file: a.file } : null
  const s = [...blocked.values()].find((x) => x.kind === 'assistant' && x.assistant === a.id)
  if (s) return waitingRow(s, a.title, open)
  if (a.status !== 'needs-you') return null
  return row({
    id: `waiting:${a.id}`,
    icon: 'needs',
    tone: 'warning',
    title: a.title,
    sub: 'Asked you something',
    open,
  })
}

/**
 * Workers split by whether their own session is blocked on Isaac (Needs input) or still runs
 * (Working). Subagents never ask Isaac; only a session of its own can block.
 */
function splitWorkers<T extends { w: Worker; owner: string | null }>(
  running: readonly T[],
  blocked: ReadonlyMap<string, RelaySession>,
): { needs: ContextRow[]; working: ContextRow[] } {
  const needs: ContextRow[] = []
  const working: ContextRow[] = []
  for (const { w, owner } of running) {
    const s = w.session === w.file ? blocked.get(sessionId(w.file)) : undefined
    if (s) needs.push(waitingRow(s, w.name, { kind: 'chat', file: w.file }))
    else working.push(workerRow(w, owner))
  }
  return { needs, working }
}

/** The button: what runs, else what blocks, else what waits for a look; the dot only for blocked or running. */
function tasksButton(t: Tasks): Pick<ContextSnapshot['button'], 'label' | 'dot'> {
  const n = t.needs.length
  return {
    label:
      t.working.length > 0
        ? `${t.working.length} running`
        : n > 0
          ? `${n} ${n === 1 ? 'needs' : 'need'} you`
          : t.review.length > 0
            ? `${t.review.length} to review`
            : null,
    dot: n > 0 ? 'needs' : t.working.length > 0 ? 'running' : null,
  }
}

function assistantWorkers(c: Ctx, a: Assistant): Worker[] {
  const own = a.file ? subagentsOf(a.file, c.now, c.d.lines) : []
  return [...own, ...assistantSessions(c.d.evaRoot, a.id, c.now, c.d.lines)]
}

function assistantHere(c: Ctx, agentId: string): Here {
  const agents = c.d.assistants()
  const a = agents.find((x) => x.id === agentId)
  const title = a?.title ?? agentId
  if (!a) {
    return {
      kind: 'assistant',
      button: {
        icon: 'activity',
        label: null,
        dot: null,
        summary: `${title} is not in the registry`,
      },
      sections: [],
      actions: [],
    }
  }
  const workers = assistantWorkers(c, a)
  const blocked = blockedSessions(c.d.relaySessions())
  const running = workers.filter((w) => w.running).sort((x, y) => y.at - x.at)
  const notesOf = new Map(agents.map((x) => [x.id, assistantNotes(c.d.evaRoot, x.id)]))
  const owners = itemOwners(
    c.items,
    agents.map((x) => ({ id: x.id, scope: x.scope, notes: notesOf.get(x.id) ?? '' })),
  )
  const notes = notesOf.get(a.id) ?? ''
  // A Test Bench run is this assistant's when its notes name it (with or without the date prefix).
  const experiments = c.experiments.filter(
    (e) =>
      e.status === 'running' &&
      (notes.includes(e.id) || notes.includes(e.id.replace(/^\d{4}-\d{2}-\d{2}-/, ''))),
  )
  const thread = threadWaitingRow(a, blocked)
  const live = splitWorkers(
    running.map((w) => ({ w, owner: null })),
    blocked,
  )
  const mine = askGroups(asks(c.items, c.now, 7 * DAY_MS).filter((i) => owners.get(i.key) === a.id))
  const tasks: Tasks = {
    needs: [...(thread ? [thread] : []), ...live.needs, ...mine.needs],
    review: mine.review,
    working: [...live.working, ...experiments.map(experimentRow)],
    resolved: workers
      .filter((w) => !w.running && c.now - w.at < DAY_MS)
      .sort((x, y) => y.at - x.at)
      .map((w) => workerRow(w, null)),
  }
  const parts = taskSummary(tasks)
  return {
    kind: 'assistant',
    button: {
      icon: 'activity',
      ...tasksButton(tasks),
      summary: `${title}: ${parts.join(', ') || 'nothing running'}`,
    },
    sections: taskSections(tasks),
    actions: [],
  }
}

function everywhere(c: Ctx): Here {
  const agents = c.d.assistants()
  const blocked = blockedSessions(c.d.relaySessions())
  const workers = agents.flatMap((a) =>
    assistantWorkers(c, a).map((w) => ({ w, owner: a.title as string | null })),
  )
  const live = splitWorkers(
    workers.filter((x) => x.w.running).sort((a, b) => b.w.at - a.w.at),
    blocked,
  )
  // Blocked chats and job runs no assistant started; an assistant's own are listed above.
  const listed = new Set(workers.map((x) => sessionId(x.w.file)))
  const loose = [...blocked.values()]
    .filter((s) => s.kind !== 'assistant' && !listed.has(s.id))
    .map((s) => {
      const file = c.d.sessionFile(s.id)
      return waitingRow(s, s.title || 'Untitled chat', file ? { kind: 'chat', file } : null)
    })
  const open = askGroups(asks(c.items, c.now, 7 * DAY_MS))
  const recent: Array<{ at: number; row: ContextRow }> = [
    ...c.jobs
      .filter(
        (j) => j.runState !== 'running' && j.lastRunAt !== null && c.now - j.lastRunAt < DAY_MS / 2,
      )
      .filter((j) => j.runState === 'ok' || j.runState === 'failed')
      .map((j) => ({ at: j.lastRunAt!, row: jobRow(j, c.now) })),
    ...c.experiments
      .filter(
        (e) => ['pass', 'fail', 'inconclusive'].includes(e.status) && c.now - e.updatedAt < DAY_MS,
      )
      .map((e) => ({
        at: e.updatedAt,
        row: { ...experimentRow(e), time: { at: e.updatedAt, style: 'clock' as const } },
      })),
    ...workers
      .filter((x) => !x.w.running && c.now - x.w.at < DAY_MS)
      .map((x) => ({ at: x.w.at, row: workerRow(x.w, x.owner) })),
  ]
  recent.sort((a, b) => b.at - a.at)
  const tasks: Tasks = {
    needs: [
      ...agents.map((a) => threadWaitingRow(a, blocked)).filter(nonNull),
      ...live.needs,
      ...loose,
      ...open.needs,
    ],
    review: open.review,
    working: [
      ...c.jobs.filter((j) => j.runState === 'running').map((j) => jobRow(j, c.now)),
      ...c.experiments.filter((e) => e.status === 'running').map(experimentRow),
      ...live.working,
    ],
    resolved: recent.map((r) => r.row),
  }
  const parts = taskSummary(tasks)
  return {
    kind: 'none',
    button: {
      icon: 'activity',
      ...tasksButton(tasks),
      summary: parts.length > 0 ? `Everywhere: ${parts.join(', ')}` : 'Nothing running',
    },
    sections: taskSections(tasks),
    actions: [],
  }
}

export async function buildSnapshot(d: SnapshotDeps, q: ContextQuery): Promise<ContextSnapshot> {
  const now = d.now()
  const c: Ctx = {
    d,
    now,
    hot: q.open,
    items: d.items(),
    jobs: d.jobs(),
    experiments: await d.experiments(),
  }
  let here: Here | null = null
  if (q.agent !== null) here = assistantHere(c, q.agent)
  else if (q.file !== null) here = chatHere(c, q.file)
  const scope = here === null ? 'everywhere' : q.scope
  const live = scope === 'here' && here !== null ? here : everywhere(c)
  return {
    kind: here?.kind ?? 'none',
    button: (here ?? live).button,
    scope,
    pinned: d.pins().map((ref) => pinRow(c, ref)),
    sections: live.sections,
    actions: scope === 'here' ? live.actions : [],
    footer: {
      jobsRunning: c.jobs.filter((j) => j.runState === 'running').length,
      jobsScheduled: c.jobs.filter((j) => j.enabled && j.scheduled).length,
      benchRunning: c.experiments.filter((e) => e.status === 'running').length,
    },
    updatedAt: now,
  }
}
