// Which pull requests belong to a ticket: Linear's attachments (its GitHub integration links a PR
// by branch name), the PR the board card already tracks, and the org's PRs whose title or head
// branch carries the key. A search hit that only mentions the key in its body is someone else's
// PR (a follow-up naming the ticket), so it stays out.
import type { AgentPr, LinearTicket, ReviewPrHit } from '@evaos/contract'

export type PrVia = 'linear' | 'agent' | 'branch' | 'title'

export interface TicketPr {
  repo: string
  number: number
  url: string
  /** The PR's title when a source knew it, else null (the tab shows repo#number). */
  title: string | null
  state: 'open' | 'draft' | 'merged' | 'closed' | null
  via: PrVia
}

const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/

/** `owner/repo` and number of a GitHub PR link, else null. */
export function prOfUrl(url: string): { repo: string; number: number } | null {
  const m = PR_URL.exec(url)
  return m ? { repo: m[1]!, number: Number(m[2]) } : null
}

/** The key as its own token: `fix/ENG-6832-x` and `ref ENG-6832 ...` match, `ENG-68321` does not. */
export function namesKey(text: string, key: string): boolean {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9])${esc}(?![0-9])`, 'i').test(text)
}

function stateOfHit(h: ReviewPrHit): TicketPr['state'] {
  if (h.state === 'MERGED') return 'merged'
  if (h.state === 'CLOSED') return 'closed'
  return h.draft ? 'draft' : 'open'
}

const STATE_RANK: Record<string, number> = { open: 0, draft: 1, merged: 2, closed: 3 }

/**
 * The ticket's PRs, one per repo#number: the first source to name a PR decides its `via`
 * (attachment, the card's PR, branch, title); a search hit fills in title and state. Open and
 * draft PRs come first, then merged, then closed, each newest number first.
 */
export function ticketPrs(input: {
  key: string
  links: LinearTicket['links']
  cardPr: AgentPr | null
  hits: readonly ReviewPrHit[]
}): TicketPr[] {
  const byId = new Map<string, TicketPr>()
  const idOf = (repo: string, number: number): string => `${repo.toLowerCase()}#${number}`
  const add = (pr: TicketPr): void => {
    const id = idOf(pr.repo, pr.number)
    const seen = byId.get(id)
    byId.set(id, seen ? { ...seen, state: seen.state ?? pr.state } : pr)
  }
  for (const l of input.links) {
    const ref = prOfUrl(l.url)
    if (ref) add({ ...ref, url: l.url, title: l.title || null, state: null, via: 'linear' })
  }
  if (input.cardPr) {
    const p = input.cardPr
    add({ repo: p.repo, number: p.number, url: p.url, title: null, state: p.state, via: 'agent' })
  }
  for (const h of input.hits) {
    const id = idOf(h.repo, h.number)
    const seen = byId.get(id)
    // A search hit knows the live title and state: they win over an attachment's or a card's.
    if (seen) {
      byId.set(id, { ...seen, title: h.title, state: stateOfHit(h) })
      continue
    }
    const via = namesKey(h.head, input.key)
      ? 'branch'
      : namesKey(h.title, input.key)
        ? 'title'
        : null
    if (via) {
      add({ repo: h.repo, number: h.number, url: h.url, title: h.title, state: stateOfHit(h), via })
    }
  }
  return [...byId.values()].sort(
    (a, b) =>
      (STATE_RANK[a.state ?? 'open'] ?? 0) - (STATE_RANK[b.state ?? 'open'] ?? 0) ||
      b.number - a.number,
  )
}
