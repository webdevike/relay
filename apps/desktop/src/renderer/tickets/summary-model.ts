import type { AgentCard } from '@evaos/contract'
import type { NeedsYou, TicketComment, TicketDetail, TicketPrRef } from '@relay/protocol'
import { agoLabel } from '../agents-board/board-view'

/** The "Waiting on your reply" line: the newest mention on this ticket that asks Isaac. */
export interface WaitingLine {
  provider: 'linear' | 'github'
  itemId: string
  commentId: string
  author: { name: string; avatarUrl: string | null }
  at: number
  excerpt: string
  count: number
  /** Set when the mention sits on a PR: clicking opens the PR route, not a ticket comment. */
  pr: TicketPrRef | null
}

/** The "Needs you:" line: the one thing to do and the evidence it rests on. */
export interface NeedsLine {
  kind: NeedsYou['kind']
  text: string
  action: { kind: NeedsYou['action']['kind']; label: string; pr: TicketPrRef | null }
  evidence: string
}

type CardTicket = NonNullable<AgentCard['ticket']>

function newest<T extends { at: number }>(rows: readonly T[]): T | null {
  return rows.reduce<T | null>((a, b) => (a === null || b.at > a.at ? b : a), null)
}

function waitingOf(detail: TicketDetail | null, t: CardTicket | null): WaitingLine | null {
  const w = newest(detail?.attention.waiting ?? [])
  if (w !== null) {
    const pr = 'pr' in w.anchor ? w.anchor.pr : null
    return { ...w, author: { name: w.author.name, avatarUrl: w.author.avatarUrl }, pr }
  }
  const c = t?.waiting ?? null
  return c === null ? null : { ...c, pr: c.anchor.pr }
}

function needsOf(detail: TicketDetail | null, t: CardTicket | null): NeedsLine | null {
  const n = detail?.attention.needsYou ?? null
  if (n === null) return t?.needsYou ?? null
  return { ...n, action: { ...n.action, pr: n.action.pr ?? null } }
}

/**
 * What waits on Isaac here. The page's own facts win over the card's (fresher); the card fills in
 * when the page has none (fallback mode carries no Attention). A "Needs you" that only says
 * "waiting on your reply" is the waiting line already, so it isn't shown twice.
 */
export function attentionLines(
  detail: TicketDetail | null,
  card: AgentCard | null,
): { waiting: WaitingLine | null; needs: NeedsLine | null } {
  const t = card?.ticket ?? null
  const waiting = waitingOf(detail, t)
  const needs = needsOf(detail, t)
  if (needs?.kind === 'waiting' && waiting !== null) return { waiting, needs: null }
  return { waiting, needs }
}

/** Comments by others; Isaac's own never count as news. */
function othersComments(comments: readonly TicketComment[], meId: string | null): TicketComment[] {
  return comments.filter((c) => meId === null || c.author?.id !== meId)
}

/** Comments by others after the watermark kept for this visit; null on a first visit. */
export function commentsSince(
  comments: readonly TicketComment[],
  previousSeenAt: number | null,
  meId: string | null,
): number | null {
  if (previousSeenAt === null) return null
  return othersComments(comments, meId).filter((c) => c.at > previousSeenAt).length
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export interface FooterPr {
  repo: string
  number: number
  label: string
}

/** The footer's PRs: "PR #12 draft", "PR #13 open", from the page or else the card. */
export function footerPrs(detail: TicketDetail | null, card: AgentCard | null): FooterPr[] {
  if (detail !== null && detail.prFacts.length > 0) {
    return detail.prFacts.map((p) => ({
      repo: p.repo,
      number: p.number,
      label: `PR #${p.number} ${p.state === 'open' && p.draft ? 'draft' : p.state}`,
    }))
  }
  return (card?.ticket?.prs ?? []).map((p) => ({
    repo: p.repo,
    number: p.number,
    label: `PR #${p.number} ${p.state}`,
  }))
}

/** "Updated 2h ago", "3 comments since you last looked" (or "5 comments"): the text segments. */
export function footerText(input: {
  updatedAt: number | null
  now: number
  comments: readonly TicketComment[]
  previousSeenAt: number | null
  meId: string | null
}): string[] {
  const parts: string[] = []
  if (input.updatedAt !== null) {
    const ago = agoLabel(input.updatedAt, input.now)
    parts.push(ago === 'now' ? 'Updated just now' : `Updated ${ago} ago`)
  }
  const fresh = commentsSince(input.comments, input.previousSeenAt, input.meId)
  const all = othersComments(input.comments, input.meId).length
  if (fresh !== null && fresh > 0) parts.push(`${plural(fresh, 'comment')} since you last looked`)
  else if (all > 0) parts.push(plural(all, 'comment'))
  return parts
}
