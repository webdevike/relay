// The Agents board's cards and the column each one belongs in. Pure over what the readers found:
// work item ledgers, an assistant's auto-work state, the runs (host activity items and the
// sessions an assistant registered), PR facts and Linear states. Every rule names the fact it
// read, so a card can say why it sits where it does.
import {
  ItemKeySchema,
  type AgentBoard,
  type AgentCard,
  type AgentColumn,
  type AgentLink,
  type AgentOpen,
  type AgentPill,
  type AgentPr,
  type LinearIssue,
} from '@evaos/contract'
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
  open: AgentOpen | null
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

export interface BoardInput {
  now: number
  items: readonly Item[]
  autoWork: readonly AutoWork[]
  runs: readonly Run[]
  /** Who owns each work item (an assistant's name), for items no run or auto-work names. */
  owners: ReadonlyMap<string, string>
  /** Cached PR facts; null until gh answered. Only asked for cards that are not stale. */
  pr: (repo: string, number: number) => PrFacts | null
  /** Cached Linear issue by key; null when unknown or not fetched yet. */
  linear: (key: string) => LinearIssue | null
  /** Isaac's In Progress Linear tickets (the ones auto-work would pick up). */
  linearStarted: readonly LinearIssue[]
}

const ENG_KEY = /^[A-Z][A-Z0-9]*-\d+$/

/** Every ticket key the board shows a card for (one a card can carry: ItemKeySchema's shape). */
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

/** The board: one card per ticket or work item (its runs folded in), one per run of its own. */
export function buildBoard(input: BoardInput): AgentBoard['cards'] {
  const { now } = input
  const keys = ticketKeys(input)
  const items = new Map(input.items.map((i) => [i.key, i]))
  const started = new Set(input.linearStarted.map((l) => l.identifier))
  const auto = new Map<string, { a: AutoWork; watch: Watch | null; kickoff: Kickoff | null }>()
  for (const a of input.autoWork) {
    for (const k of new Set([...Object.keys(a.tickets), ...Object.keys(a.started), ...a.flagged])) {
      if (auto.has(k)) continue
      auto.set(k, { a, watch: a.tickets[k] ?? null, kickoff: a.started[k] ?? null })
    }
  }

  // Each ticket's PRs (the one auto-work watches first), for matching runs by PR number.
  const prsOf = new Map<string, Array<{ repo: string; number: number; url: string }>>()
  for (const key of keys) {
    const refs = [prFromUrl(auto.get(key)?.watch?.pr), items.get(key)?.pr ?? null].filter(
      (r): r is { repo: string; number: number; url: string } => r !== null,
    )
    prsOf.set(
      key,
      refs.filter((r, i) => refs.findIndex((x) => x.url === r.url) === i),
    )
  }
  const byPrNumber = new Map<number, string[]>()
  for (const [key, refs] of prsOf) {
    for (const r of refs) byPrNumber.set(r.number, [...(byPrNumber.get(r.number) ?? []), key])
  }
  const kickoffSessions = new Map<string, string>()
  for (const [key, x] of auto) {
    if (x.kickoff?.sessionFile) kickoffSessions.set(sessionId(x.kickoff.sessionFile), key)
  }

  // Runs go to the ticket their title, transcript or PR number names; the rest are cards of their own.
  const runsOf = new Map<string, Run[]>()
  const loose: Run[] = []
  for (const r of input.runs) {
    let owners = keysNamed(r.title, keys)
    if (owners.length === 0 && r.session && kickoffSessions.has(r.session)) {
      owners = [kickoffSessions.get(r.session)!]
    }
    if (owners.length === 0) {
      for (const m of r.title.matchAll(/(?<!\d)(\d{3,6})(?!\d)/g)) {
        const hit = byPrNumber.get(Number(m[1]))
        if (hit && hit.length === 1) owners = hit
      }
    }
    if (owners.length === 0) {
      // Registered sessions that sit idle belong to a ticket or to nobody's board.
      if (r.status !== 'open') loose.push(r)
      continue
    }
    for (const k of owners) runsOf.set(k, [...(runsOf.get(k) ?? []), r])
  }

  const cards: AgentCard[] = []
  for (const key of keys) {
    const item = items.get(key) ?? null
    const x = auto.get(key)
    const watch = x?.watch ?? null
    const kickoff = x?.kickoff ?? null
    const runs = runsOf.get(key) ?? []
    const run = pickRun(runs)
    const refs = prsOf.get(key) ?? []
    const lin = ENG_KEY.test(key) ? input.linear(key) : null
    const startedLin = input.linearStarted.find((l) => l.identifier === key) ?? null
    const issue = lin ?? startedLin
    const times = [
      item?.updatedMs ?? null,
      ms(watch?.phaseAt),
      ms(kickoff?.endedAt) ?? ms(kickoff?.at),
      run?.at ?? null,
      issue?.updatedAt ?? null,
    ].filter((t): t is number => t !== null)
    const activityAt = times.length > 0 ? Math.max(...times) : null
    const running = run?.status === 'working' || run?.status === 'waiting'
    const stale = !running && (activityAt === null || now - activityAt > STALE_MS)
    const primary = refs[0] ?? null
    const prFacts = primary && !stale ? input.pr(primary.repo, primary.number) : null
    const unstarted = (x?.a.flagged.includes(key) ?? false) || started.has(key)
    const place = placeTicket({
      key,
      item,
      watch,
      kickoff,
      pr: prFacts,
      linear: issue,
      run,
      unstarted: unstarted && item === null && watch === null,
    })
    if (place.column === 'done' && (activityAt === null || now - activityAt > DONE_MS)) continue
    const linearUrl = item?.linear ?? kickoff?.url ?? issue?.url ?? null
    const links: AgentLink[] = []
    if (linearUrl && /^https?:\/\//.test(linearUrl)) {
      links.push({
        kind: 'linear',
        label: key,
        sub: issue?.state ?? null,
        open: { kind: 'url', url: linearUrl },
      })
    }
    for (const r of refs) {
      links.push({
        kind: 'pr',
        label: `${r.repo}#${r.number}`,
        sub: null,
        open: { kind: 'url', url: r.url },
      })
    }
    for (const r of runs
      .slice()
      .sort((a, b) => b.at - a.at)
      .slice(0, 4)) {
      if (r.open) links.push({ kind: 'session', label: r.title, sub: r.intent, open: r.open })
    }
    if (runs.length === 0 && kickoff?.sessionFile?.endsWith('.jsonl')) {
      links.push({
        kind: 'session',
        label: `${key} auto-work`,
        sub: kickoff.note ?? null,
        open: { kind: 'chat', file: kickoff.sessionFile },
      })
    }
    if (item) {
      links.push({
        kind: 'ledger',
        label: `work/items/${key}.md`,
        sub: item.stage,
        open: { kind: 'files', path: item.file },
      })
      if (item.worktree) {
        links.push({
          kind: 'worktree',
          label: item.worktree.split('/').slice(-2).join('/'),
          sub: item.branch,
          open: { kind: 'files', path: item.worktree },
        })
      }
    }
    cards.push({
      id: `item:${key}`,
      kind: 'item',
      key,
      title: item?.title ?? kickoff?.title ?? issue?.title ?? key,
      column: place.column,
      pill: place.pill,
      reason: place.reason,
      workspace: item?.workspace ?? null,
      agent: run?.agent ?? x?.a.agent ?? input.owners.get(key) ?? null,
      session: run?.title ?? (kickoff?.sessionFile ? `${key} auto-work` : null),
      intent: run?.intent ?? null,
      stage: item?.stage ?? null,
      move: item?.move ?? null,
      next: item?.next ?? null,
      phase: watch && watch.phase !== 'unwatched' ? watch.phase : null,
      pr: primary ? agentPr(primary, prFacts) : null,
      linear: issue
        ? { key, url: issue.url || null, state: issue.state, stateType: issue.stateType }
        : null,
      activityAt,
      stale,
      links: links.slice(0, 12),
    })
  }

  for (const r of loose) {
    const place = placeRun(r)
    if (place.column === 'done' && now - r.at > DONE_MS) continue
    const link: AgentLink | null = r.open
      ? { kind: 'session', label: r.title, sub: r.intent, open: r.open }
      : null
    cards.push({
      id: `run:${r.id}`,
      kind: r.kind,
      key: null,
      title: r.title || 'Untitled run',
      column: place.column,
      pill: place.pill,
      reason: place.reason,
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
      links: link ? [link] : [],
    })
  }
  cards.sort((a, b) => (b.activityAt ?? 0) - (a.activityAt ?? 0))
  return cards
}
