// The Agents board's cards and the column each one belongs in. Pure over what the readers found:
// work item ledgers, an assistant's auto-work state, the runs (host activity items and the
// sessions an assistant registered), PR facts, Linear states and the host's synced tickets. Every
// rule names the fact it read, so a card can say why it sits where it does.
import { createHash } from 'node:crypto'
import {
  ItemKeySchema,
  type AgentBoard,
  type AgentCard,
  type AgentColumn,
  type AgentLink,
  type AgentOpen,
  type AgentPill,
  type AgentPr,
  type CardTicket,
  type LinearIssue,
} from '@evaos/contract'
import type {
  AttentionAnchor,
  NeedsYou,
  TicketActor,
  TicketBoardFacts,
  TicketPrFacts,
  WaitingMention,
} from '@relay/protocol'
import type { PrFacts } from '../context-popover/gh'
import { sessionId } from '@evaos/chat-core/session-id'
import { itemFinished, itemReady, type Item } from '../context-popover/items'

export const DAY_MS = 86_400_000
/** A card nothing touched for this long, with nothing running on it, is stale (hidden by default). */
export const STALE_MS = 7 * DAY_MS
/** The Done column keeps a week. */
export const DONE_MS = 7 * DAY_MS

/** One ticket in an assistant's auto-work state (`tickets[key]`). */
export interface Watch {
  phase: string
  phaseAt?: string
  pr?: string
  bouncedAt?: string
  bounceNote?: string
}

/** One auto-work session kickoff (`started[key]`). */
export interface Kickoff {
  title?: string
  url?: string
  at?: string
  phase?: string
  state?: string
  sessionFile?: string
  endedAt?: string
  escalatedAt?: string
  note?: string
}

/** An assistant's auto-work state (`work/eva/agents/<id>/auto-work.json`), with the assistant's name. */
export interface AutoWork {
  agent: string
  tickets: Readonly<Record<string, Watch>>
  started: Readonly<Record<string, Kickoff>>
  /** In Progress tickets with no work item or no open PR, as the last daily sweep found them. */
  flagged: readonly string[]
}

/** One agent run: a host activity item, or a session an assistant registered (its files). */
export interface Run {
  id: string
  kind: 'helper' | 'session' | 'harness' | 'canvas'
  title: string
  /** `open`: a registered session that is idle but not closed (it picks up the next handoff). */
  status: 'working' | 'waiting' | 'done' | 'failed' | 'open'
  intent: string | null
  /** Who runs it (an assistant's or a chat's name). */
  agent: string | null
  at: number
  /** Its omp session id, when it is a session (to match an auto-work kickoff's transcript). */
  session: string | null
  /** What opening it shows: its chat, transcript or pane. */
  open: AgentOpen
}

export interface Placement {
  column: AgentColumn
  pill: AgentPill
  reason: string
}

export interface TicketFacts {
  key: string
  item: Item | null
  watch: Watch | null
  kickoff: Kickoff | null
  pr: PrFacts | null
  linear: Pick<LinearIssue, 'state' | 'stateType'> | null
  /** The run on it that matters most: waiting, else working, else the latest. */
  run: Run | null
  /** The daily sweep flagged it, or it is In Progress in Linear with no work yet. */
  unstarted: boolean
}

const PHASE_LABEL: Record<string, string> = {
  intake: 'Intake',
  'pre-review': 'Pre-review',
  'in-review': 'In review',
  'post-review': 'Post-review',
}

/** The column a ticket or work item belongs in, the small pill on its card and why. */
export function placeTicket(f: TicketFacts): Placement {
  const { item, watch, kickoff, pr, linear, run } = f
  const stage = item?.stage?.trim() ?? ''
  const move = item?.move ?? ''
  if (linear && (linear.stateType === 'completed' || linear.stateType === 'canceled')) {
    return {
      column: 'done',
      pill: { label: linear.state, tone: linear.stateType === 'completed' ? 'success' : 'default' },
      reason: `${linear.state} in Linear`,
    }
  }
  if (/^(done|closed)\b/i.test(stage)) {
    return {
      column: 'done',
      pill: { label: 'Done', tone: 'success' },
      reason: `Ledger stage ${stage}`,
    }
  }
  const kickoffLive = kickoff?.state === 'running' || kickoff?.state === 'starting'
  if (
    item === null &&
    run?.status !== 'working' &&
    run?.status !== 'waiting' &&
    !kickoffLive &&
    !f.unstarted &&
    (watch === null || watch.phase === 'unwatched')
  ) {
    return {
      column: 'done',
      pill: { label: 'Closed', tone: 'default' },
      reason: 'Its ledger is closed and auto-work no longer watches it',
    }
  }
  if (run?.status === 'waiting') {
    return {
      column: 'needs',
      pill: { label: 'Asking you', tone: 'warning' },
      reason: run.intent || `${run.title} waits on you`,
    }
  }
  if (run?.status === 'working' || kickoffLive) {
    const phase = watch?.phase ?? kickoff?.phase
    return {
      column: 'working',
      pill: { label: (phase && PHASE_LABEL[phase]) || 'Running', tone: 'info' },
      reason: run ? `${run.title} is running` : `Auto-work session ${kickoff?.state}`,
    }
  }
  if (kickoff?.escalatedAt) {
    return {
      column: 'needs',
      pill: { label: 'Stuck', tone: 'danger' },
      reason: 'Its session failed and the restarts ran out; auto-work asked you',
    }
  }
  if (watch?.bouncedAt) {
    return {
      column: 'needs',
      pill: { label: 'QA bounced', tone: 'danger' },
      reason: watch.bounceNote || 'Bounced back from QA; needs a fix pass',
    }
  }
  if (move === 'isaac') {
    return {
      column: 'needs',
      pill: { label: item && itemReady(item) ? 'Review' : 'Your move', tone: 'warning' },
      reason: item?.next || 'Your move',
    }
  }
  const waitingOn =
    move !== '' && move !== 'eva' ? move.charAt(0).toUpperCase() + move.slice(1) : null
  const qaState = linear && /\bqa\b/i.test(linear.state) ? linear.state : null
  if (
    pr?.state === 'MERGED' ||
    watch?.phase === 'post-review' ||
    qaState !== null ||
    (item !== null && itemFinished(item))
  ) {
    return {
      column: 'qa',
      pill: {
        label:
          qaState ??
          (waitingOn
            ? `Waiting on ${waitingOn}`
            : pr?.state === 'MERGED'
              ? 'Merged'
              : stage || 'Merged'),
        tone: 'info',
      },
      reason: item?.next || (qaState ? `${qaState} in Linear` : 'Merged; waiting on QA'),
    }
  }
  if (
    (pr?.state === 'OPEN' && !pr.draft) ||
    watch?.phase === 'in-review' ||
    (linear !== null && /review/i.test(linear.state)) ||
    (waitingOn !== null && (pr !== null || (item !== null && itemReady(item))))
  ) {
    const pill: AgentPill =
      pr?.decision === 'CHANGES_REQUESTED'
        ? { label: 'Changes requested', tone: 'warning' }
        : pr?.decision === 'APPROVED'
          ? { label: 'Approved', tone: 'success' }
          : waitingOn
            ? { label: `Waiting on ${waitingOn}`, tone: 'default' }
            : { label: 'In review', tone: 'info' }
    return { column: 'review', pill, reason: item?.next || 'Out for review' }
  }
  if (item === null && f.unstarted) {
    return {
      column: 'queued',
      pill: { label: 'Not started', tone: 'default' },
      reason: 'In Progress in Linear with no work item yet',
    }
  }
  if (waitingOn) {
    return {
      column: 'queued',
      pill: { label: `Waiting on ${waitingOn}`, tone: 'default' },
      reason: item?.next || `Waiting on ${waitingOn}`,
    }
  }
  return {
    column: 'queued',
    pill: { label: pr?.draft ? 'Draft PR' : stage ? stage : 'Queued', tone: 'default' },
    reason: item?.next || "The agent's move; nothing is running on it",
  }
}

/** Where a run of its own (no ticket) belongs. */
export function placeRun(r: Run): Placement {
  switch (r.status) {
    case 'working':
      return {
        column: 'working',
        pill: { label: 'Running', tone: 'info' },
        reason: r.intent || 'Working',
      }
    case 'waiting':
      return {
        column: 'needs',
        pill: { label: 'Asking you', tone: 'warning' },
        reason: r.intent || 'Waiting on you',
      }
    case 'failed':
      return {
        column: 'done',
        pill: { label: 'Failed', tone: 'danger' },
        reason: r.intent || 'Failed',
      }
    default:
      return {
        column: 'done',
        pill: { label: 'Done', tone: 'success' },
        reason: r.intent || 'Finished',
      }
  }
}

const KEYISH = /([A-Za-z]{2,10})-?(\d{2,6})/g

/**
 * The ticket keys a run's title names: `ENG-6832 auto-work`, a helper `Eng6832QaFixes`, a slug key
 * (`relay-rooms`) spelled out. Only keys the board knows count.
 */
export function keysNamed(title: string, known: ReadonlySet<string>): string[] {
  const out = new Set<string>()
  for (const m of title.matchAll(KEYISH)) {
    const key = `${m[1]!.toUpperCase()}-${m[2]}`
    if (known.has(key)) out.add(key)
  }
  const lower = title.toLowerCase()
  for (const key of known) {
    if (key.length >= 6 && !/^[A-Z]+-\d+$/.test(key) && lower.includes(key.toLowerCase()))
      out.add(key)
  }
  return [...out]
}

/** The run that matters most for a card: waiting, else working, else open, else the latest. */
export function pickRun(runs: readonly Run[]): Run | null {
  const rank = (r: Run): number =>
    r.status === 'waiting' ? 4 : r.status === 'working' ? 3 : r.status === 'open' ? 2 : 1
  let best: Run | null = null
  for (const r of runs) {
    if (!best || rank(r) > rank(best) || (rank(r) === rank(best) && r.at > best.at)) best = r
  }
  return best
}

export function prFromUrl(
  url: string | undefined | null,
): { repo: string; number: number; url: string } | null {
  const m = url ? /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(url) : null
  return m
    ? { repo: m[1]!, number: Number(m[2]), url: `https://github.com/${m[1]}/pull/${m[2]}` }
    : null
}

export function agentPr(
  ref: { repo: string; number: number; url: string },
  facts: PrFacts | null,
): AgentPr {
  const c = facts?.checks
  return {
    repo: ref.repo,
    number: ref.number,
    url: ref.url,
    state:
      facts === null
        ? null
        : facts.state === 'MERGED'
          ? 'merged'
          : facts.state === 'CLOSED'
            ? 'closed'
            : facts.draft
              ? 'draft'
              : 'open',
    decision: facts?.decision ?? null,
    checks: !c
      ? null
      : c.total === 0
        ? 'none'
        : c.failed > 0
          ? 'fail'
          : c.pending > 0
            ? 'pending'
            : 'pass',
  }
}

const ms = (iso: string | undefined): number | null => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? null : t
}

/** The host's synced Linear board; null when the board falls back to local Linear states. */
export interface SyncedTickets {
  tickets: readonly TicketBoardFacts[]
  /** The host advertises `tickets.writes`. */
  writes: boolean
}

export interface BoardInput {
  now: number
  items: readonly Item[]
  autoWork: readonly AutoWork[]
  runs: readonly Run[]
  /** Who owns each work item (an assistant's name), for items no run or auto-work names. */
  owners: ReadonlyMap<string, string>
  /** Cached PR facts; null until gh answered. Only asked for cards that are not stale. */
  pr: (repo: string, number: number) => PrFacts | null
  /** Cached Linear issue by key; null when unknown or not fetched yet (fallback only). */
  linear: (key: string) => LinearIssue | null
  /** Isaac's In Progress Linear tickets (the ones auto-work would pick up; fallback only). */
  linearStarted: readonly LinearIssue[]
  tickets: SyncedTickets | null
}

const ENG_KEY = /^[A-Z][A-Z0-9]*-\d+$/
const WEB_URL = /^https?:\/\//

export const DRAG_BLOCK = {
  fallback: 'Moving cards needs Linear sync on the host',
  noIssue: 'No Linear issue',
  writesOff: 'Writes are off on the host',
} as const

/** Every ticket key the board shows an agent card for (one a card can carry: ItemKeySchema's shape). */
export function ticketKeys(
  input: Pick<BoardInput, 'items' | 'autoWork' | 'linearStarted'>,
): Set<string> {
  const all = [
    ...input.items.map((i) => i.key),
    ...input.autoWork.flatMap((a) => [
      ...Object.keys(a.tickets),
      ...Object.keys(a.started),
      ...a.flagged,
    ]),
    ...input.linearStarted.map((l) => l.identifier),
  ]
  return new Set(all.filter((k) => ItemKeySchema.safeParse(k).success))
}

/** The Linear keys worth asking about: ticket keys on cards that are not stale. */
export function linearKeys(cards: readonly AgentCard[]): string[] {
  return cards
    .filter((c) => c.kind === 'item' && c.key && ENG_KEY.test(c.key) && !c.stale)
    .map((c) => c.key!)
}

/** The Linear keys on agent cards the host's board doesn't hold yet (to `tickets.watch`). */
export function watchKeys(cards: readonly AgentCard[]): string[] {
  const synced = new Set(cards.filter((c) => c.ticket !== null).map((c) => c.key))
  return linearKeys(cards).filter((k) => !synced.has(k))
}

// A synced issue with no agent work: §2.4 of the board plan.

const namedState = (t: Pick<TicketBoardFacts, 'state'>, name: string): boolean =>
  t.state.name.trim().toLowerCase() === name

/** Where a synced Linear issue with no agent work belongs. */
export function placeSynced(t: Pick<TicketBoardFacts, 'state' | 'prFacts'>): Placement {
  const { name, type } = t.state
  const at = (column: AgentColumn, tone: AgentPill['tone']): Placement => ({
    column,
    pill: { label: name, tone },
    reason: `${name} in Linear`,
  })
  if (type === 'completed') return at('done', 'success')
  if (type === 'canceled') return at('done', 'default')
  if (namedState(t, 'in qa')) return at('qa', 'info')
  if (namedState(t, 'in review')) return at('review', 'info')
  const pr = t.prFacts.find((p) => p.state === 'open' && !p.draft)
  if (pr) return { ...at('review', 'info'), reason: `PR #${pr.number} is open` }
  if (namedState(t, 'design review')) return at('needs', 'warning')
  if (type === 'started') return at('working', 'info')
  return at('queued', 'default')
}

const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s)
const person = (a: TicketActor): { name: string; avatarUrl: string | null } => ({
  name: cut(a.name, 200),
  avatarUrl: a.avatarUrl,
})

function cardPr(p: TicketPrFacts): CardTicket['prs'][number] {
  return {
    repo: p.repo,
    number: p.number,
    url: p.url,
    title: cut(p.title, 400),
    state: p.state === 'open' && p.draft ? 'draft' : p.state,
    checks: p.checks.state,
    decision: p.decision,
  }
}

function anchorOf(a: AttentionAnchor): NonNullable<CardTicket['waiting']>['anchor'] {
  const line =
    a.kind === 'pr-review-line'
      ? { path: a.path, line: a.line, side: a.side }
      : { path: null, line: null, side: null }
  return { kind: a.kind, pr: 'pr' in a ? a.pr : null, ...line }
}

function waitingOf(w: WaitingMention | undefined): CardTicket['waiting'] {
  if (!w) return null
  const { provider, itemId, rootId, commentId, at, excerpt, count } = w
  const author = person(w.author)
  return {
    provider,
    itemId,
    rootId,
    commentId,
    author,
    at,
    excerpt,
    count,
    anchor: anchorOf(w.anchor),
  }
}

/** The host's Needs you, else the agent card's own Needs reason (evidence: the reason's hash). */
function needsYouOf(n: NeedsYou | null, agentReason: string | null): CardTicket['needsYou'] {
  if (n) {
    const action = { kind: n.action.kind, label: cut(n.action.label, 200), pr: n.action.pr ?? null }
    return { kind: n.kind, text: cut(n.text, 200), action, evidence: n.evidence }
  }
  if (!agentReason) return null
  const hash = createHash('sha256').update(agentReason).digest('hex').slice(0, 16)
  return {
    kind: 'agent',
    text: cut(agentReason, 200),
    action: { kind: 'open', label: 'Open', pr: null },
    evidence: `agent:${hash}`,
  }
}

/** A card's ticket facts from the host's board; `agentReason`: the agent card's Needs reason. */
export function cardTicket(t: TicketBoardFacts, agentReason: string | null): CardTicket {
  const { project: p, milestone: m, parent, children } = t
  const done = children.filter((c) => c.done).length
  return {
    id: t.id,
    state: {
      id: t.state.id,
      name: cut(t.state.name, 80),
      type: t.state.type,
      color: t.state.color,
    },
    team: { id: t.team.id, key: cut(t.team.key, 20) },
    priority: t.priority,
    project: p && { id: p.id, name: cut(p.name, 200) },
    milestone: m && { id: m.id, name: cut(m.name, 200), targetDate: m.targetDate },
    labels: t.labels.slice(0, 10).map((l) => ({ name: cut(l.name, 80), color: l.color })),
    parent: parent && { key: parent.key, title: cut(parent.title, 400) },
    sub: children.length === 0 ? null : { done, total: children.length },
    assignee: t.assignee && person(t.assignee),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    prs: t.prFacts.map(cardPr),
    waiting: waitingOf(t.attention.waiting[0]),
    needsYou: needsYouOf(t.attention.needsYou, agentReason),
  }
}

// The board.

type PrRef = { repo: string; number: number; url: string }
type AutoEntry = { a: AutoWork; watch: Watch | null; kickoff: Kickoff | null }
type Issue = Pick<LinearIssue, 'title' | 'url' | 'state' | 'stateType' | 'updatedAt'>

interface Ctx {
  input: BoardInput
  items: ReadonlyMap<string, Item>
  auto: ReadonlyMap<string, AutoEntry>
  started: ReadonlySet<string>
  prsOf: ReadonlyMap<string, PrRef[]>
  runsOf: ReadonlyMap<string, Run[]>
  synced: ReadonlyMap<string, TicketBoardFacts>
}

function autoByKey(autoWork: readonly AutoWork[]): Map<string, AutoEntry> {
  const auto = new Map<string, AutoEntry>()
  for (const a of autoWork) {
    for (const k of new Set([...Object.keys(a.tickets), ...Object.keys(a.started), ...a.flagged])) {
      if (!auto.has(k))
        auto.set(k, { a, watch: a.tickets[k] ?? null, kickoff: a.started[k] ?? null })
    }
  }
  return auto
}

/** Each ticket's PRs (the one auto-work watches first), for matching runs by PR number. */
function prsByKey(
  keys: ReadonlySet<string>,
  auto: ReadonlyMap<string, AutoEntry>,
  items: ReadonlyMap<string, Item>,
): Map<string, PrRef[]> {
  const prsOf = new Map<string, PrRef[]>()
  for (const key of keys) {
    const refs = [prFromUrl(auto.get(key)?.watch?.pr), items.get(key)?.pr ?? null].filter(
      (r): r is PrRef => r !== null,
    )
    prsOf.set(
      key,
      refs.filter((r, i) => refs.findIndex((x) => x.url === r.url) === i),
    )
  }
  return prsOf
}

interface RunIndex {
  keys: ReadonlySet<string>
  byPrNumber: ReadonlyMap<number, string[]>
  kickoffSessions: ReadonlyMap<string, string>
}

function runIndex(
  keys: ReadonlySet<string>,
  prsOf: ReadonlyMap<string, PrRef[]>,
  auto: ReadonlyMap<string, AutoEntry>,
): RunIndex {
  const byPrNumber = new Map<number, string[]>()
  for (const [key, refs] of prsOf) {
    for (const r of refs) byPrNumber.set(r.number, [...(byPrNumber.get(r.number) ?? []), key])
  }
  const kickoffSessions = new Map<string, string>()
  for (const [key, x] of auto) {
    if (x.kickoff?.sessionFile) kickoffSessions.set(sessionId(x.kickoff.sessionFile), key)
  }
  return { keys, byPrNumber, kickoffSessions }
}

/** The tickets a run works on: named in its title, its transcript an auto-work kickoff, or its PR. */
function runOwners(r: Run, ix: RunIndex): string[] {
  const named = keysNamed(r.title, ix.keys)
  if (named.length > 0) return named
  const kicked = r.session === null ? undefined : ix.kickoffSessions.get(r.session)
  if (kicked) return [kicked]
  let owners: string[] = []
  for (const m of r.title.matchAll(/(?<!\d)(\d{3,6})(?!\d)/g)) {
    const hit = ix.byPrNumber.get(Number(m[1]))
    if (hit?.length === 1) owners = hit
  }
  return owners
}

/** Runs go to the ticket they work on; the rest are cards of their own. */
function assignRuns(
  runs: readonly Run[],
  ix: RunIndex,
): { runsOf: Map<string, Run[]>; loose: Run[] } {
  const runsOf = new Map<string, Run[]>()
  const loose: Run[] = []
  for (const r of runs) {
    const owners = runOwners(r, ix)
    // Registered sessions that sit idle belong to a ticket or to nobody's board.
    if (owners.length === 0 && r.status !== 'open') loose.push(r)
    for (const k of owners) runsOf.set(k, [...(runsOf.get(k) ?? []), r])
  }
  return { runsOf, loose }
}

/** A key's Linear issue: the host's synced one, else (fallback) the local Linear states. */
function issueOf(key: string, ctx: Ctx): Issue | null {
  const t = ctx.synced.get(key)
  if (t) {
    const { title, url, updatedAt } = t
    return { title, url, updatedAt, state: t.state.name, stateType: t.state.type }
  }
  const lin = ENG_KEY.test(key) ? ctx.input.linear(key) : null
  return lin ?? ctx.input.linearStarted.find((l) => l.identifier === key) ?? null
}

const isLive = (run: Run | null): boolean => run?.status === 'working' || run?.status === 'waiting'

interface ItemFacts {
  facts: TicketFacts
  auto: NoAuto | AutoEntry
  runs: Run[]
  refs: PrRef[]
  issue: Issue | null
  activityAt: number | null
  stale: boolean
}
type NoAuto = { a: null; watch: null; kickoff: null }
const NO_AUTO: NoAuto = { a: null, watch: null, kickoff: null }

/** Epoch ms of the newest thing that happened on a ticket: ledger, phase, kickoff, run, Linear. */
function activityOf(
  f: Pick<TicketFacts, 'item' | 'watch' | 'kickoff' | 'run'>,
  issue: Issue | null,
): number | null {
  const { item, watch, kickoff, run } = f
  const kickoffAt = ms(kickoff?.endedAt) ?? ms(kickoff?.at)
  const times = [item?.updatedMs, ms(watch?.phaseAt), kickoffAt, run?.at, issue?.updatedAt]
  const known = times.filter((t): t is number => typeof t === 'number')
  return known.length > 0 ? Math.max(...known) : null
}

/** Flagged by the daily sweep or In Progress in Linear, with no work item or watch yet. */
function unstartedOf(key: string, ctx: Ctx, x: NoAuto | AutoEntry, item: Item | null): boolean {
  const flagged = x.a?.flagged.includes(key) || ctx.started.has(key)
  return flagged === true && item === null && x.watch === null
}

function itemFacts(key: string, ctx: Ctx): ItemFacts {
  const item = ctx.items.get(key) ?? null
  const x = ctx.auto.get(key) ?? NO_AUTO
  const { watch, kickoff } = x
  const runs = ctx.runsOf.get(key) ?? []
  const run = pickRun(runs)
  const issue = issueOf(key, ctx)
  const activityAt = activityOf({ item, watch, kickoff, run }, issue)
  const stale = !isLive(run) && (activityAt === null || ctx.input.now - activityAt > STALE_MS)
  const refs = ctx.prsOf.get(key) ?? []
  const pr = refs[0] && !stale ? ctx.input.pr(refs[0].repo, refs[0].number) : null
  const unstarted = unstartedOf(key, ctx, x, item)
  const facts = { key, item, watch, kickoff, pr, linear: issue, run, unstarted }
  return { facts, auto: x, runs, refs, issue, activityAt, stale }
}

function linearLink(key: string, f: ItemFacts): AgentLink[] {
  const { item, kickoff } = f.facts
  const urls = [item?.linear, kickoff?.url, f.issue?.url]
  const url = urls.find((u): u is string => typeof u === 'string' && WEB_URL.test(u))
  if (!url) return []
  return [
    { kind: 'linear', label: key, sub: f.issue ? f.issue.state : null, open: { kind: 'url', url } },
  ]
}

const prLink = (r: PrRef): AgentLink => ({
  kind: 'pr',
  label: `${r.repo}#${r.number}`,
  sub: null,
  open: { kind: 'url', url: r.url },
})
const runLink = (r: Run): AgentLink => ({
  kind: 'session',
  label: r.title,
  sub: r.intent,
  open: r.open,
})

function sessionLinks(key: string, f: ItemFacts): AgentLink[] {
  const kickoff = f.facts.kickoff
  if (f.runs.length === 0 && kickoff?.sessionFile?.endsWith('.jsonl')) {
    const open = { kind: 'chat', file: kickoff.sessionFile } as const
    return [{ kind: 'session', label: `${key} auto-work`, sub: kickoff.note ?? null, open }]
  }
  return f.runs
    .slice()
    .sort((a, b) => b.at - a.at)
    .slice(0, 4)
    .map(runLink)
}

function ledgerLinks(key: string, item: Item | null): AgentLink[] {
  if (!item) return []
  const ledger: AgentLink = {
    kind: 'ledger',
    label: `work/items/${key}.md`,
    sub: item.stage,
    open: { kind: 'files', path: item.file },
  }
  if (!item.worktree) return [ledger]
  const label = item.worktree.split('/').slice(-2).join('/')
  const open = { kind: 'files', path: item.worktree } as const
  return [ledger, { kind: 'worktree', label, sub: item.branch, open }]
}

/** Why a card can't be dragged under the host's board: no Linear issue, or writes are off. */
function syncedDragBlock(t: TicketBoardFacts | null, s: SyncedTickets): string | null {
  if (!t) return DRAG_BLOCK.noIssue
  return s.writes ? null : DRAG_BLOCK.writesOff
}

/** An agent card can't be dragged while its agent runs it: the column follows the run. */
function itemDragBlock(f: ItemFacts, ctx: Ctx, agent: string | null): string | null {
  if (!ctx.input.tickets) return DRAG_BLOCK.fallback
  const k = f.facts.kickoff?.state
  if (isLive(f.facts.run) || k === 'running' || k === 'starting') {
    return `${agent ?? 'Astra'} is working on this; the column follows her run`
  }
  return syncedDragBlock(ctx.synced.get(f.facts.key) ?? null, ctx.input.tickets)
}

const oldDone = (place: Placement, at: number | null, now: number): boolean =>
  place.column === 'done' && (at === null || now - at > DONE_MS)

const NO_LEDGER = { title: null, workspace: null, stage: null, move: null, next: null }

/** The card's title, the fields an agent card takes from its ledger, and the auto-work phase. */
function ledgerText(key: string, f: ItemFacts) {
  const { title, workspace, stage, move, next } = f.facts.item ?? NO_LEDGER
  const watch = f.facts.watch
  return {
    title: title ?? f.facts.kickoff?.title ?? f.issue?.title ?? key,
    workspace,
    stage,
    move,
    next,
    phase: watch && watch.phase !== 'unwatched' ? watch.phase : null,
  }
}

/** Who runs it and what it does now: its run or auto-work kickoff. */
function runText(key: string, f: ItemFacts, ctx: Ctx) {
  const { kickoff, run } = f.facts
  const kicked = kickoff?.sessionFile ? `${key} auto-work` : null
  return {
    agent: run?.agent ?? f.auto.a?.agent ?? ctx.input.owners.get(key) ?? null,
    session: run ? run.title : kicked,
    intent: run ? run.intent : null,
  }
}

/** One ticket or work item with agent work: placed by its agent facts, synced facts attached. */
function itemCard(key: string, ctx: Ctx): AgentCard | null {
  const f = itemFacts(key, ctx)
  const place = placeTicket(f.facts)
  if (oldDone(place, f.activityAt, ctx.input.now)) return null
  const t = ctx.synced.get(key)
  const text = runText(key, f, ctx)
  const links = [linearLink(key, f), f.refs.map(prLink), sessionLinks(key, f)]
  const issue = f.issue
  return {
    id: `item:${key}`,
    kind: 'item',
    key,
    ...place,
    ...ledgerText(key, f),
    ...text,
    pr: f.refs[0] ? agentPr(f.refs[0], f.facts.pr) : null,
    linear: issue && {
      key,
      url: issue.url || null,
      state: cut(issue.state, 80),
      stateType: issue.stateType,
    },
    activityAt: f.activityAt,
    stale: f.stale,
    links: [...links.flat(), ...ledgerLinks(key, f.facts.item)].slice(0, 12),
    ticket: t ? cardTicket(t, place.column === 'needs' ? place.reason : null) : null,
    openTarget: ENG_KEY.test(key) ? { kind: 'ticket', key } : { kind: 'item', id: key },
    dragBlock: itemDragBlock(f, ctx, text.agent),
  }
}

/** The synced issue's first PR as the card's PR. */
function syncedPr(t: TicketBoardFacts): AgentPr | null {
  const p = t.prFacts[0]
  if (!p || !WEB_URL.test(p.url)) return null
  const { repo, number, url, state, checks, decision } = cardPr(p)
  return { repo, number, url, state, checks, decision }
}

function syncedLinks(t: TicketBoardFacts): AgentLink[] {
  const linear: AgentLink[] = WEB_URL.test(t.url)
    ? [{ kind: 'linear', label: t.key, sub: t.state.name, open: { kind: 'url', url: t.url } }]
    : []
  const prs = t.prFacts.filter((p) => WEB_URL.test(p.url)).map(prLink)
  return [...linear, ...prs].slice(0, 12)
}

/** A synced Linear issue with no agent work: kind `ticket`, placed by its Linear state. */
function syncedCard(t: TicketBoardFacts, s: SyncedTickets, now: number): AgentCard | null {
  const place = placeSynced(t)
  if (oldDone(place, t.updatedAt, now)) return null
  return {
    id: `ticket:${t.key}`,
    kind: 'ticket',
    key: t.key,
    title: cut(t.title, 400),
    ...place,
    workspace: null,
    agent: null,
    session: null,
    intent: null,
    stage: null,
    move: null,
    next: null,
    phase: null,
    pr: syncedPr(t),
    linear: {
      key: t.key,
      url: t.url || null,
      state: cut(t.state.name, 80),
      stateType: t.state.type,
    },
    activityAt: t.updatedAt,
    stale: false,
    links: syncedLinks(t),
    ticket: cardTicket(t, null),
    openTarget: { kind: 'ticket', key: t.key },
    dragBlock: syncedDragBlock(t, s),
  }
}

/** A run of its own (no ticket): a helper, session, harness pane or canvas room. */
function runCard(r: Run, ctx: Ctx): AgentCard | null {
  const place = placeRun(r)
  if (place.column === 'done' && ctx.input.now - r.at > DONE_MS) return null
  return {
    id: `run:${r.id}`,
    kind: r.kind,
    key: null,
    title: r.title || 'Untitled run',
    ...place,
    workspace: null,
    agent: r.agent,
    session: r.title || null,
    intent: r.intent,
    stage: null,
    move: null,
    next: null,
    phase: null,
    pr: null,
    linear: null,
    activityAt: r.at,
    stale: false,
    links: [runLink(r)],
    ticket: null,
    openTarget: { kind: 'link', open: r.open },
    dragBlock: ctx.input.tickets ? DRAG_BLOCK.noIssue : DRAG_BLOCK.fallback,
  }
}

/**
 * The board: one card per ticket or work item with agent work (its runs and synced facts folded
 * in), one per synced Linear issue with none (same key: one card), one per run of its own.
 */
export function buildBoard(input: BoardInput): AgentBoard['cards'] {
  const keys = ticketKeys(input)
  const items = new Map(input.items.map((i) => [i.key, i]))
  const auto = autoByKey(input.autoWork)
  const prsOf = prsByKey(keys, auto, items)
  const { runsOf, loose } = assignRuns(input.runs, runIndex(keys, prsOf, auto))
  const s = input.tickets
  const synced = new Map((s?.tickets ?? []).map((t) => [t.key, t]))
  const started = new Set(input.linearStarted.map((l) => l.identifier))
  const ctx: Ctx = { input, items, auto, started, prsOf, runsOf, synced }
  const pure = s ? s.tickets.filter((t) => !keys.has(t.key)) : []
  const cards = [
    ...[...keys].map((k) => itemCard(k, ctx)),
    ...pure.map((t) => syncedCard(t, s!, input.now)),
    ...loose.map((r) => runCard(r, ctx)),
  ].filter((c): c is AgentCard => c !== null)
  cards.sort((a, b) => (b.activityAt ?? 0) - (a.activityAt ?? 0))
  return cards
}
