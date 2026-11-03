// A Reviews item (pull request, Linear issue, Slack thread) as a place of its own, the way a chat
// or a canvas board is: `review:pr:owner/repo#12`, `review:linear:ENG-6693`,
// `review:slack:<channel>:<threadTs>`. Such a place opens in its own tab or pane, restores from the
// layout, and is named by its title (names-store) like any other tab. Imports no store, so tab
// titles can use it.
import { placeOf, type Place } from '@evaos/shell-core'
import { shortPrId } from './queue-search'
import type { ReviewItem } from './reviews-store'

export type ReviewRef =
  | { kind: 'pr'; repo: string; number: number }
  | { kind: 'linear'; key: string }
  | { kind: 'slack'; channel: string; threadTs: string | null }

const PREFIX = 'review:'

export function reviewRefOf(item: ReviewItem): ReviewRef {
  if (item.kind === 'pr') return { kind: 'pr', repo: item.row.repo, number: item.row.number }
  if (item.kind === 'linear') return { kind: 'linear', key: item.row.key }
  return { kind: 'slack', channel: item.row.channel, threadTs: item.row.threadTs }
}

/** The id after `review:`; the key of the item's stored title. */
export function reviewIdOf(ref: ReviewRef): string {
  if (ref.kind === 'pr') return `pr:${ref.repo}#${ref.number}`
  if (ref.kind === 'linear') return `linear:${ref.key}`
  return `slack:${ref.channel}:${ref.threadTs ?? ''}`
}

export function reviewPlaceOf(ref: ReviewRef): Place {
  return placeOf(`${PREFIX}${reviewIdOf(ref)}`)
}

/** The id a `review:` place carries, else null. */
export function reviewIdOfPlace(place: Place): string | null {
  return place.page.startsWith(PREFIX) ? place.page.slice(PREFIX.length) : null
}

/** The item a `review:` place shows, or null for any other place or an id this app does not make. */
export function reviewRefOfId(id: string): ReviewRef | null {
  const pr = /^pr:([^#\s]+\/[^#\s]+)#(\d+)$/.exec(id)
  if (pr) return { kind: 'pr', repo: pr[1]!, number: Number(pr[2]) }
  const linear = /^linear:([A-Za-z][A-Za-z0-9]*-\d+)$/.exec(id)
  if (linear) return { kind: 'linear', key: linear[1]!.toUpperCase() }
  const slack = /^slack:([A-Z0-9]+):(.*)$/.exec(id)
  if (slack) {
    return { kind: 'slack', channel: slack[1]!, threadTs: slack[2] === '' ? null : slack[2]! }
  }
  return null
}

export function reviewRefOfPlace(place: Place): ReviewRef | null {
  const id = reviewIdOfPlace(place)
  return id === null ? null : reviewRefOfId(id)
}

/** What a tab or pane tab says: `#172 Fix the thing`, `ENG-6693 Title`, `#ui-ux thread`. */
export function reviewTitleOf(item: ReviewItem): string {
  if (item.kind === 'pr') {
    const { row } = item
    return row.title.startsWith(row.repo) ? shortPrId(row) : `#${row.number} ${row.title}`
  }
  if (item.kind === 'linear') {
    const { row } = item
    return row.title === row.key ? row.key : `${row.key} ${row.title}`
  }
  const { row } = item
  return row.threadTs && row.kind === 'reply' ? `${row.channelName} thread` : row.channelName
}

/** The title a tab shows before it has been read: from the id alone. */
export function reviewFallbackTitle(id: string): string {
  const ref = reviewRefOfId(id)
  if (ref?.kind === 'pr') return shortPrId(ref)
  if (ref?.kind === 'linear') return ref.key
  if (ref?.kind === 'slack') return 'Slack thread'
  return id
}

export type ReviewIcon = 'IconGitPullRequest' | 'IconTicket' | 'IconBrandSlack'

export function reviewIconOf(id: string): ReviewIcon {
  if (id.startsWith('linear:')) return 'IconTicket'
  if (id.startsWith('slack:')) return 'IconBrandSlack'
  return 'IconGitPullRequest'
}
