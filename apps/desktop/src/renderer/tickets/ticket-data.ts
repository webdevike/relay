// What the ticket page reads: the host's synced ticket (`tickets.ticket`), or, without host sync,
// the Linear read Reviews already makes (`reviews.linearTicket`) adapted to the same shape. Which
// one served it decides how the page writes: through the host's gate, through the old Reviews
// path, or not at all.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { AgentCard, LinearTicket, ReviewPrHit } from '@evaos/contract'
import {
  TicketsStatus,
  TicketStateType,
  type TicketComment,
  type TicketDetail,
  type TicketPrFacts,
} from '@relay/protocol'
import { invoke, on } from '../ipc'
import { bindPref, parseBool } from '../ui-prefs'
import { useAgentsBoard } from '../agents-board/agents-store'
import { prOfUrl, ticketPrs, type TicketPr } from '../agents-board/ticket-prs'

/** gate: the host's write gate; legacy: Reviews' own Linear writes (fallback); none: read-only. */
export type WriteMode = 'gate' | 'legacy' | 'none'

export interface TicketMe {
  linearViewerId: string | null
  name: string | null
}

export interface TicketData {
  key: string
  /** Null while loading or unavailable. */
  detail: TicketDetail | null
  source: 'host' | 'fallback'
  /** `Linear details unavailable: <reason>`, or null. */
  unavailable: string | null
  writeMode: WriteMode
  me: TicketMe
  /** Reads it again (after a write; on `tickets.changed` for this key it happens by itself). */
  refresh(): void
}

const NO_ME: TicketMe = { linearViewerId: null, name: null }

const PRIORITY: Record<string, number> = { Urgent: 1, High: 2, Medium: 3, Low: 4 }
const DONE_STATE = /^(done|completed|canceled|cancelled|duplicate)$/i

const person = (name: string | null, id = name ?? '') =>
  name ? { id, name, avatarUrl: null } : null

function commentOf(c: LinearTicket['comments'][number]): TicketComment {
  return {
    id: c.id,
    parentId: c.parentId,
    documentContentId: null,
    quotedText: null,
    author: { id: c.author.handle, name: c.author.name, avatarUrl: null },
    body: c.body,
    at: c.at,
    editedAt: null,
    resolvedAt: null,
    resolvingUser: null,
    reactions: [],
    url: c.url,
  }
}

function stateTypeOf(type: string): TicketDetail['state']['type'] {
  const parsed = TicketStateType.safeParse(type)
  return parsed.success ? parsed.data : 'unstarted'
}

/**
 * The legacy Reviews read as the page's shape: what it knows (title, description, state by name,
 * people by name, labels, project, parent, sub-issues, linked PRs, comments); ids it never had are
 * empty and the rest (milestone, relations, PR facts, attention) is empty or null.
 */
export function fromLinearTicket(t: LinearTicket): TicketDetail {
  return {
    key: t.key,
    id: t.id,
    documentContentId: null,
    title: t.title,
    description: t.description,
    url: t.url,
    state: { id: '', name: t.state.name, type: stateTypeOf(t.state.type), color: t.state.color },
    team: { id: '', key: t.key.split('-')[0] ?? t.team },
    priority: PRIORITY[t.priority] ?? 0,
    prioritySortOrder: 0,
    assignee: person(t.assignee),
    creator: person(t.creator),
    labels: t.labels.map((l) => ({ id: l.name, name: l.name, color: l.color })),
    project: t.project ? { id: '', name: t.project, targetDate: null } : null,
    milestone: null,
    parent: t.parent ? { id: '', key: t.parent.key, title: t.parent.title } : null,
    children: t.children.map((c) => ({
      id: '',
      key: c.key,
      title: c.title,
      done: DONE_STATE.test(c.state),
    })),
    relations: [],
    prs: t.links.flatMap((l) => {
      const ref = prOfUrl(l.url)
      return ref ? [ref] : []
    }),
    dueDate: null,
    startedAt: null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    subscribed: false,
    prFacts: [],
    attention: { waiting: [], needsYou: null },
    comments: t.comments.map(commentOf),
  }
}

export interface LoadedTicket {
  detail: TicketDetail | null
  source: 'host' | 'fallback'
  unavailable: string | null
  me: TicketMe
}

/** The Linear account the host acts as (its board's status), for "mine" on comments. */
async function hostMe(): Promise<TicketMe> {
  const r = await invoke('tickets.board', {})
  if (!r.ok || r.value.source !== 'host') return NO_ME
  const status = TicketsStatus.safeParse(r.value.status)
  const linear = status.success ? status.data.identity.linear : null
  return linear ? { linearViewerId: linear.viewerId, name: linear.name } : NO_ME
}

/**
 * One read of `key`: the host's ticket when it serves tickets and has this one; else the legacy
 * Linear read; else why neither could (the host's reason first, it is the newer path).
 */
export async function loadTicket(key: string): Promise<LoadedTicket> {
  const r = await invoke('tickets.ticket', { key })
  if (r.ok && r.value.source === 'host') {
    const detail = r.value.ticket as unknown as TicketDetail
    return { detail, source: 'host', unavailable: null, me: await hostMe() }
  }
  const hostWhy = r.ok ? null : r.error.message
  const f = await invoke('reviews.linearTicket', { key })
  if (f.ok) {
    const me = { linearViewerId: null, name: f.value.me.name }
    return { detail: fromLinearTicket(f.value), source: 'fallback', unavailable: null, me }
  }
  const why = hostWhy ?? f.error.message
  return {
    detail: null,
    source: hostWhy === null ? 'fallback' : 'host',
    unavailable: `Linear details unavailable: ${why}`,
    me: NO_ME,
  }
}

/** The page's write path: the gate only when the host served it and opens writes. */
export function writeModeOf(source: 'host' | 'fallback', hostWrites: boolean): WriteMode {
  if (source === 'fallback') return 'legacy'
  return hostWrites ? 'gate' : 'none'
}

const EMPTY: LoadedTicket = { detail: null, source: 'fallback', unavailable: null, me: NO_ME }

/** `key`'s page data, re-read on `tickets.changed` naming it (or the whole board). */
export function useTicketData(key: string | null): TicketData {
  const [loaded, setLoaded] = useState<LoadedTicket>(EMPTY)
  const hostWrites = useAgentsBoard((s) => s.board?.sources.tickets.writes ?? false)
  const ask = useRef(0)
  const refresh = useCallback(() => {
    if (key === null) return
    const n = ++ask.current
    void loadTicket(key).then((l) => {
      if (n === ask.current) setLoaded(l)
    })
  }, [key])
  useEffect(() => {
    setLoaded(EMPTY)
    refresh()
    if (key === null) return
    return on('tickets.changed', ({ keys }) => {
      if (keys === null || keys.includes(key)) refresh()
    })
  }, [key, refresh])
  return {
    key: key ?? '',
    ...loaded,
    writeMode: key === null ? 'none' : writeModeOf(loaded.source, hostWrites),
    refresh,
  }
}

type CardPr = NonNullable<AgentCard['ticket']>['prs'][number]

/** `p` with the freshest facts known: the host's, else the synced card's. */
function freshen(
  p: TicketPr,
  facts: readonly TicketPrFacts[],
  cardPrs: readonly CardPr[],
): TicketPr {
  const f = facts.find((x) => samePr(x, p))
  if (f) return { ...p, title: f.title, state: f.draft && f.state === 'open' ? 'draft' : f.state }
  const c = cardPrs.find((x) => samePr(x, p))
  return c ? { ...p, title: p.title ?? c.title, state: p.state ?? c.state } : p
}

/** The PRs the host's ticket and the synced card link, as Linear attachment rows. */
function linksOf(detail: TicketDetail | null, cardPrs: readonly CardPr[]) {
  const facts = detail?.prFacts ?? []
  const refs = detail?.prs ?? []
  return [
    ...facts.map((f) => ({ title: f.title, url: f.url, kind: 'github' })),
    ...refs.map((p) => ({
      title: '',
      url: `https://github.com/${p.repo}/pull/${p.number}`,
      kind: 'github',
    })),
    ...cardPrs.map((p) => ({ title: p.title, url: p.url, kind: 'github' })),
  ]
}

/**
 * The page's pull requests (ticket-prs.ts: attachments, the card's PR, title/branch hits), each
 * with the freshest facts known.
 */
export function pagePrs(input: {
  key: string | null
  detail: TicketDetail | null
  card: AgentCard | null
  hits: readonly ReviewPrHit[]
}): TicketPr[] {
  const facts = input.detail?.prFacts ?? []
  const cardPrs = input.card?.ticket?.prs ?? []
  const prs = ticketPrs({
    key: input.key ?? '',
    links: linksOf(input.detail, cardPrs),
    cardPr: input.card?.pr ?? null,
    hits: input.hits,
  })
  return prs.map((p) => freshen(p, facts, cardPrs))
}

interface TicketPrRefLike {
  repo: string
  number: number
}

export const samePr = (a: TicketPrRefLike, b: TicketPrRefLike): boolean =>
  a.number === b.number && a.repo.toLowerCase() === b.repo.toLowerCase()

/** `repo#number`, one PR's identity on the page (two repos can share a number). */
export const prId = (p: TicketPrRefLike): string => `${p.repo.toLowerCase()}#${p.number}`

// The properties sidebar's fold is Isaac's choice: kept in layout.json.
interface TicketsUiState {
  /** The properties sidebar is open (else the status strip stands in for it). */
  sidebar: boolean
}

export const ticketsUiStore = createStore<TicketsUiState>(() => ({ sidebar: true }))

export function useTicketsUi<T>(selector: (s: TicketsUiState) => T): T {
  return useStore(ticketsUiStore, selector)
}

export function setSidebarOpen(open: boolean): void {
  ticketsUiStore.setState({ sidebar: open })
}

bindPref(ticketsUiStore, 'tickets.sidebar', {
  select: (s) => s.sidebar,
  apply: (sidebar) => ({ sidebar }),
  parse: parseBool,
})
