import type { LinearRow, ReviewRow, SlackRow } from '@evaos/contract'
import type { ReviewItem } from './reviews-store'

/** Where a queue item comes from. */
export type QueueSource = 'github' | 'linear' | 'slack'
export type SourceFilter = 'all' | QueueSource

export const SOURCE_FILTERS: Array<{ value: SourceFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'github', label: 'GitHub' },
  { value: 'linear', label: 'Linear' },
  { value: 'slack', label: 'Slack' },
]

/**
 * A typed item reference as the link Reviews opens: a bare Linear key (`ENG-6693`) or a pull
 * request as `owner/repo#246`. Any other text comes back unchanged (it may already be a link).
 */
export function itemLinkOf(text: string): string {
  const t = text.trim()
  if (/^[a-z][a-z0-9]*-\d+$/i.test(t)) return `https://linear.app/issue/${t.toUpperCase()}`
  const pr = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(t)
  if (pr) return `https://github.com/${pr[1]}/pull/${pr[2]}`
  return t
}

/** `api#246`: a pull request's repo name without its owner, the way the queue shows it. */
export const shortPrId = (r: { repo: string; number: number }): string =>
  `${r.repo.split('/').pop()}#${r.number}`

/** One id per item across sources, so a queue row and a parsed link compare equal. */
export function itemId(item: ReviewItem): string {
  if (item.kind === 'pr') return prId(item.row)
  if (item.kind === 'linear') return linearId(item.row)
  return slackId(item.row)
}
export const prId = (r: ReviewRow): string => `pr:${r.repo.toLowerCase()}#${r.number}`
export const linearId = (r: LinearRow): string => `linear:${r.key}`
export const slackId = (r: SlackRow): string => `slack:${r.channel}:${r.threadTs ?? ''}`

/** The words of a search, lowercased; every word must appear in a row for it to match. */
export const queryWords = (q: string): string[] => q.toLowerCase().split(/\s+/).filter(Boolean)

function hits(fields: readonly string[], words: readonly string[]): boolean {
  const hay = fields.join('\n').toLowerCase()
  return words.every((w) => hay.includes(w))
}

/** Title, `owner/repo#246` (so `#246` and `repo#246` match too), author and link. */
export const prMatches = (r: ReviewRow, words: readonly string[]): boolean =>
  hits([r.title, `${r.repo}#${r.number}`, r.author, r.url], words)

/** Title, key, the person and what they did, and link. */
export const linearMatches = (r: LinearRow, words: readonly string[]): boolean =>
  hits([r.title, r.key, r.actor, r.reason, r.url], words)

/** Channel (or DM name), the message, its author and link. */
export const slackMatches = (r: SlackRow, words: readonly string[]): boolean =>
  hits([r.channelName, r.text, r.author, r.url], words)

/** The search's Open row label for an item the queue does not list. */
export function openLabel(item: ReviewItem): string {
  if (item.kind === 'pr') return `Open PR ${shortPrId(item.row)}`
  if (item.kind === 'linear') return `Open ${item.row.key}`
  return item.row.kind === 'dm' ? 'Open Slack conversation' : 'Open Slack thread'
}

export const sourceOf = (item: ReviewItem): QueueSource =>
  item.kind === 'pr' ? 'github' : item.kind
