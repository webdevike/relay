// A ticket's page as a place of its own, the way a review item is: `ticket:ENG-12` (a Linear
// ticket), `ticket:item/relay-demo` (a ledger-only work item), `ticket:ENG-12/pr/acme/app/7` (one
// of its pull requests; the repo is in the place, so #7 in two repos are two places), and an
// optional `#comment-<id>` naming the comment to show. Imports no store, so tab titles can use it.
import { AGENT_COLUMNS, type AgentCard, type AgentColumn } from '@evaos/contract'
import { placeOf, type Place } from '@evaos/shell-core'
import { reviewTitle } from '../eva/names-store'

const PREFIX = 'ticket:'

export interface TicketPrRef {
  repo: string
  number: number
}

export interface TicketRef {
  /** `key`: a Linear key; `item`: a work item's ledger id. */
  kind: 'key' | 'item'
  id: string
  pr: TicketPrRef | null
  comment: string | null
}

export interface TicketPlaceOptions {
  /** `key` is a work item's id, not a Linear key. */
  item?: boolean
  pr?: TicketPrRef | null
  comment?: string | null
}

const PLACE =
  /^(?:item\/([A-Za-z0-9][\w-]*)|([A-Z][A-Z0-9]*-\d+))(?:\/pr\/([\w.-]+)\/([\w.-]+)\/(\d+))?(?:#comment-(.+))?$/

/** The page key for `ref`: `ticket:` and what follows. */
export function ticketPageOf(ref: TicketRef): string {
  const head = ref.kind === 'item' ? `item/${ref.id}` : ref.id
  const pr = ref.pr ? `/pr/${ref.pr.repo}/${ref.pr.number}` : ''
  const at = ref.comment ? `#comment-${ref.comment}` : ''
  return `${PREFIX}${head}${pr}${at}`
}

export function ticketPlace(key: string, opts: TicketPlaceOptions = {}): Place {
  const ref: TicketRef = {
    kind: opts.item ? 'item' : 'key',
    id: key,
    pr: opts.pr ?? null,
    comment: opts.comment ?? null,
  }
  return placeOf(ticketPageOf(ref) as Place['page'])
}

/** What a `ticket:` page shows, or null for any other page or an id this app does not make. */
export function parseTicketPlace(page: string): TicketRef | null {
  if (!page.startsWith(PREFIX)) return null
  const m = PLACE.exec(page.slice(PREFIX.length))
  if (!m) return null
  const [, item, key, owner, repo, n, comment] = m
  return {
    kind: item ? 'item' : 'key',
    id: (item ?? key)!,
    pr: owner && repo && n ? { repo: `${owner}/${repo}`, number: Number(n) } : null,
    comment: comment ?? null,
  }
}

/** The ticket page itself (no PR, no comment), for Esc and the breadcrumb. */
export function ticketHome(ref: TicketRef): Place {
  return ticketPlace(ref.id, { item: ref.kind === 'item' })
}

/** Where opening a card goes: its ticket page, or null for a run that opens its own target. */
export function cardPlace(
  card: AgentCard,
  opts: Omit<TicketPlaceOptions, 'item'> = {},
): Place | null {
  const t = card.openTarget
  if (t.kind === 'ticket') return ticketPlace(t.key, opts)
  if (t.kind === 'item') return ticketPlace(t.id, { ...opts, item: true })
  return null
}

/** The open target's id a ticket page of `kind` would carry, else null. */
function targetId(card: AgentCard, kind: TicketRef['kind']): string | null {
  const t = card.openTarget
  if (kind === 'key') return t.kind === 'ticket' ? t.key : null
  return t.kind === 'item' ? t.id : null
}

/** The card a ticket page stands for (a key's card may also carry it only as its key). */
export function cardOfRef(cards: readonly AgentCard[], ref: TicketRef): AgentCard | null {
  const own = cards.find((c) => targetId(c, ref.kind) === ref.id)
  if (own) return own
  return ref.kind === 'key' ? (cards.find((c) => c.key === ref.id) ?? null) : null
}

type Waiting = NonNullable<NonNullable<AgentCard['ticket']>['waiting']>

/** Where a waiting chip goes: the comment on the page, or the PR it is on. */
export function waitingPlace(card: AgentCard, w: Waiting): Place | null {
  const onPr = w.anchor.kind === 'pr-conversation' || w.anchor.kind === 'pr-review-line'
  if (onPr && w.anchor.pr) return cardPlace(card, { pr: w.anchor.pr })
  return cardPlace(card, onPr ? {} : { comment: w.commentId })
}

/**
 * The board's reading order for prev/next: the shown columns left to right, each top to bottom
 * (`shown`: the cards the board shows, already filtered); cards in hidden columns follow them.
 */
export function boardOrder(
  shown: readonly AgentCard[],
  hidden: readonly AgentColumn[],
): AgentCard[] {
  const visible = AGENT_COLUMNS.filter((c) => !hidden.includes(c))
  const rank = (c: AgentColumn): number => {
    const i = visible.indexOf(c)
    return i >= 0 ? i : visible.length + AGENT_COLUMNS.indexOf(c)
  }
  return shown
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c.column) - rank(b.c.column) || a.i - b.i)
    .map((x) => x.c)
}

/** The tab's name: `ENG-12 Title` once the page was read (`· PR #7` on a PR), else the key. */
export function ticketTabTitle(page: string): string {
  const ref = parseTicketPlace(page)
  if (ref === null) return page.slice(PREFIX.length)
  const base = ref.kind === 'key' ? (reviewTitle(`linear:${ref.id}`) ?? ref.id) : ref.id
  return ref.pr ? `${base} · PR #${ref.pr.number}` : base
}
