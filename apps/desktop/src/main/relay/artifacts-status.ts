// Live states for the tickets and PRs threads hold. This app reads them (PRs through the context
// popover's PR cache, Linear through the badge card's reader; on a thin client both ask the Mini's
// Relay Host) and sends each thread one `artifacts.act {op:"status"}` batch. It runs on every snapshot,
// any thread: an item whose status is missing or older than STATUS_STALE_MS is read again, and an
// item is read and sent at most once per STATUS_STALE_MS, so the snapshot a batch causes does not
// start another.
import type { ArtifactStatus, Artifact } from '@evaos/chat-core/artifacts'
import type { LinearIssue } from '@evaos/contract'
import type { PrFacts } from '../context-popover/gh'
import type { RelayArtifacts, RelaySource } from './client'

/** A status older than this is read again. */
export const STATUS_STALE_MS = 5 * 60_000
/** Who the host sees writing statuses. */
export const STATUS_ACTOR = 'relay-desktop'

const STATE_TYPES = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'] as const
const LINEAR_KEY = /\b([a-z][a-z0-9]*-\d+)\b/i

/** `gh-pr:owner/repo#238` as repo and number; null for anything else. */
export function prRef(id: string): { repo: string; number: number } | null {
  const m = /^gh-pr:([^\s#]+\/[^\s#]+)#(\d+)$/.exec(id)
  return m ? { repo: m[1]!, number: Number(m[2]) } : null
}

/** A PR's facts as an artifact status. */
export function prStatus(pr: PrFacts, now: number): ArtifactStatus {
  const { failed, pending, total } = pr.checks
  const checks = total === 0 ? undefined : failed > 0 ? 'fail' : pending > 0 ? 'pending' : 'pass'
  const review =
    pr.decision === 'APPROVED'
      ? 'approved'
      : pr.decision === 'CHANGES_REQUESTED'
        ? 'changes'
        : pr.decision === 'REVIEW_REQUIRED'
          ? 'required'
          : undefined
  const linked = (LINEAR_KEY.exec(pr.head) ?? LINEAR_KEY.exec(pr.title))?.[1]?.toUpperCase()
  return {
    state: pr.state.toLowerCase(),
    ...(pr.title === '' ? {} : { title: pr.title.slice(0, 300) }),
    draft: pr.draft,
    ...(checks === undefined ? {} : { checks }),
    ...(review === undefined ? {} : { review }),
    ...(linked === undefined || linked.length > 20 ? {} : { linked }),
    fetchedAt: now,
  }
}

/** A Linear issue as an artifact status. */
export function linearStatus(issue: LinearIssue, now: number): ArtifactStatus {
  const stateType = STATE_TYPES.find((t) => t === issue.stateType)
  return {
    state: issue.state.toLowerCase().slice(0, 40),
    ...(stateType === undefined ? {} : { stateType }),
    ...(issue.title === '' ? {} : { title: issue.title.slice(0, 300) }),
    ...(issue.assignee === null ? {} : { assignee: issue.assignee.slice(0, 80) }),
    fetchedAt: now,
  }
}

export interface StatusReaderDeps {
  relay: RelaySource & RelayArtifacts
  /** A PR's cached facts (null until fetched or when gh is off); a refresh calls `onPrChange`. */
  pr(repo: string, number: number): PrFacts | null
  onPrChange(cb: () => void): () => void
  /** A Linear issue, or null when Linear is off for this app (fixtures, e2e). */
  linear: ((key: string) => Promise<LinearIssue | null>) | null
  now?: () => number
}

/** Starts reading statuses for every thread Relay sends; returns the stop. */
export function startStatusReader(d: StatusReaderDeps): () => void {
  const now = d.now ?? Date.now
  /** When each item was last read (Linear) or sent (both), by item id. */
  const touched = new Map<string, number>()
  const running = new Set<string>()
  const again = new Set<string>()

  const due = (item: Artifact, t: number): boolean =>
    (item.status === undefined || t - item.status.fetchedAt > STATUS_STALE_MS) &&
    t - (touched.get(item.id) ?? -Infinity) > STATUS_STALE_MS

  const scan = async (thread: string): Promise<void> => {
    if (running.has(thread)) {
      again.add(thread)
      return
    }
    running.add(thread)
    try {
      const snap = d.relay.artifacts(thread)
      if (snap === null || !d.relay.artifactsUp()) return
      const t = now()
      const statuses: Record<string, ArtifactStatus> = {}
      const reads: Array<Promise<void>> = []
      for (const item of snap.items) {
        if (!due(item, t)) continue
        if (item.kind === 'gh-pr') {
          const ref = prRef(item.id)
          const facts = ref && d.pr(ref.repo, ref.number)
          if (facts) statuses[item.id] = prStatus(facts, t)
        } else if (item.kind === 'linear' && d.linear !== null) {
          const key = item.id.slice('linear:'.length)
          if (!/^[A-Z][A-Z0-9]*-\d+$/.test(key)) continue
          touched.set(item.id, t)
          const read = d.linear
          reads.push(
            read(key).then(
              (issue) => {
                if (issue) statuses[item.id] = linearStatus(issue, now())
              },
              () => undefined,
            ),
          )
        }
      }
      await Promise.all(reads)
      const ids = Object.keys(statuses)
      if (ids.length === 0) return
      for (const id of ids) touched.set(id, t)
      await d.relay.actArtifacts(thread, STATUS_ACTOR, { op: 'status', statuses })
    } finally {
      running.delete(thread)
      if (again.delete(thread)) void scan(thread)
    }
  }
  const scanAll = (): void => {
    for (const thread of d.relay.artifactThreads().keys()) void scan(thread)
  }
  const offArtifacts = d.relay.onArtifacts((thread) => void scan(thread))
  // A PR fetched since the last snapshot: its threads can be told now.
  const offPrs = d.onPrChange(scanAll)
  return () => {
    offArtifacts()
    offPrs()
  }
}
