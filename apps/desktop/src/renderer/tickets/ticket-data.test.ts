import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LinearTicket } from '@evaos/contract'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))

import { cardOf, ticketOf } from '../agents-board/test-cards'
import { fromLinearTicket, loadTicket, pagePrs, writeModeOf } from './ticket-data'

const LEGACY: LinearTicket = {
  id: 'issue-1',
  key: 'ENG-1',
  title: 'Fix the thing',
  url: 'https://linear.app/acme/issue/ENG-1',
  description: 'Body',
  creator: 'Chris Doe',
  createdAt: 1,
  updatedAt: 2,
  state: { name: 'In Progress', type: 'started', color: '#f2c94c' },
  assignee: 'Isaac Weber',
  priority: 'High',
  labels: [{ name: 'Bug', color: '#f00' }],
  project: 'Payments',
  team: 'Engineering',
  parent: null,
  children: [
    { key: 'ENG-2', title: 'Child', url: 'u', state: 'Done' },
    { key: 'ENG-3', title: 'Other', url: 'u', state: 'Todo' },
  ],
  links: [
    { title: 'PR', url: 'https://github.com/acme/app/pull/12', kind: 'github' },
    { title: 'Doc', url: 'https://example.test/doc', kind: 'link' },
  ],
  comments: [
    {
      id: 'c-1',
      parentId: null,
      author: { name: 'Chris Doe', handle: 'chris', url: 'u' },
      body: 'Hi',
      at: 3,
      url: 'u',
      mentionsMe: true,
    },
  ],
  people: [],
  me: { name: 'Isaac Weber', handle: 'isaac', url: 'u' },
}

const STATUS = {
  identity: {
    linear: { viewerId: 'user-isaac', name: 'Isaac Weber', email: 'i@x.test', org: 'Acme' },
    github: null,
  },
  features: { tickets: true, writes: true },
  freshness: { lastSyncAt: null, lastError: null, state: 'idle' },
  errors: { linear: null, github: null },
  budget: {
    linear: { remaining: null, resetAt: null, backoffUntil: null },
    github: { remaining: null, resetAt: null, backoffUntil: null },
  },
}

type Answer = { ok: true; value: unknown } | { ok: false; error: { message: string } }
function answers(map: Record<string, Answer>): void {
  invoke.mockImplementation((channel: string) => Promise.resolve(map[channel]))
}

afterEach(() => invoke.mockReset())

describe('loadTicket', () => {
  it('reads the host ticket with the account the host acts as', async () => {
    const ticket = { ...fromLinearTicket(LEGACY), prFacts: [] }
    answers({
      'tickets.ticket': { ok: true, value: { source: 'host', ticket } },
      'tickets.board': { ok: true, value: { source: 'host', rev: 1, board: {}, status: STATUS } },
    })
    const l = await loadTicket('ENG-1')
    expect(l.source).toBe('host')
    expect(l.unavailable).toBeNull()
    expect(l.detail?.key).toBe('ENG-1')
    expect(l.me).toEqual({ linearViewerId: 'user-isaac', name: 'Isaac Weber' })
    expect(invoke).not.toHaveBeenCalledWith('reviews.linearTicket', expect.anything())
  })

  it('falls back to the Reviews read without host sync', async () => {
    answers({
      'tickets.ticket': {
        ok: true,
        value: { source: 'fallback', reason: 'oldHost', message: 'Old host' },
      },
      'reviews.linearTicket': { ok: true, value: LEGACY },
    })
    const l = await loadTicket('ENG-1')
    expect(l.source).toBe('fallback')
    expect(l.detail?.title).toBe('Fix the thing')
    expect(l.me).toEqual({ linearViewerId: null, name: 'Isaac Weber' })
  })

  it('keeps the legacy read for the legacy path', async () => {
    answers({
      'tickets.ticket': {
        ok: true,
        value: { source: 'fallback', reason: 'off', message: 'Sync is off' },
      },
      'reviews.linearTicket': { ok: true, value: LEGACY },
    })
    const l = await loadTicket('ENG-1')
    expect(l.legacy).toBe(LEGACY)
    expect(l.hostFailed).toBe(false)
  })

  it("reads through Reviews when a host that syncs can't, but opens no legacy writes", async () => {
    answers({
      'tickets.ticket': { ok: false, error: { message: 'The host has no ENG-1.' } },
      'reviews.linearTicket': { ok: true, value: LEGACY },
    })
    const l = await loadTicket('ENG-1')
    expect(l.source).toBe('fallback')
    expect(l.hostFailed).toBe(true)
    expect(writeModeOf(l.source, true, l.hostFailed)).toBe('none')
  })

  it('says why when neither can read it', async () => {
    answers({
      'tickets.ticket': { ok: false, error: { message: 'No ENG-1 on the host' } },
      'reviews.linearTicket': { ok: false, error: { message: 'Linear is off' } },
    })
    const l = await loadTicket('ENG-1')
    expect(l.detail).toBeNull()
    expect(l.unavailable).toBe('Linear details unavailable: No ENG-1 on the host')
    answers({
      'tickets.ticket': {
        ok: true,
        value: { source: 'fallback', reason: 'noHost', message: 'No host' },
      },
      'reviews.linearTicket': { ok: false, error: { message: 'Linear is off' } },
    })
    expect((await loadTicket('ENG-1')).unavailable).toBe(
      'Linear details unavailable: Linear is off',
    )
  })
})

describe('fromLinearTicket', () => {
  it('keeps what the legacy read knows', () => {
    const d = fromLinearTicket(LEGACY)
    expect(d.state).toMatchObject({ name: 'In Progress', type: 'started' })
    expect(d.priority).toBe(2)
    expect(d.assignee?.name).toBe('Isaac Weber')
    expect(d.project?.name).toBe('Payments')
    expect(d.children.map((c) => c.done)).toEqual([true, false])
    expect(d.prs).toEqual([{ repo: 'acme/app', number: 12 }])
    expect(d.comments[0]).toMatchObject({ id: 'c-1', author: { name: 'Chris Doe' }, body: 'Hi' })
    expect(d.attention).toEqual({ waiting: [], needsYou: null })
  })

  it("keeps each person's profile, so a mention becomes the link Linear notifies", () => {
    const sam = { name: 'Sam Lee', handle: 'sam', url: 'https://linear.app/acme/profiles/sam' }
    const d = fromLinearTicket({
      ...LEGACY,
      creator: 'Sam Lee',
      comments: [{ ...LEGACY.comments[0]!, author: sam }],
      people: [sam],
    })
    expect(d.creator).toEqual({ id: 'sam', name: 'Sam Lee', avatarUrl: null, url: sam.url })
    expect(d.comments[0]!.author).toMatchObject({ id: 'sam', url: sam.url })
    // Isaac (the legacy read's `me`) is the assignee: his profile too.
    expect(d.assignee).toMatchObject({ id: 'isaac', name: 'Isaac Weber' })
    const people = peopleOf(d)
    expect(people.find((p) => p.name === 'Sam Lee')).toMatchObject({ handle: 'sam', url: sam.url })
    expect(linearBody('@Sam Lee can you look?', people)).toBe(`${sam.url} can you look?`)
  })
})

describe('legacyLinksOf', () => {
  it('splits the attachments as Reviews did: PRs apart, commits counted, the rest listed', () => {
    const t = {
      ...LEGACY,
      links: [
        ...LEGACY.links,
        { title: 'c1', url: 'https://github.com/acme/app/commit/abc123', kind: 'github' },
        { title: 'c2', url: 'https://github.com/acme/app/commit/def456', kind: 'github' },
      ],
    }
    expect(legacyLinksOf(t)).toEqual({
      commits: 2,
      other: [{ title: 'Doc', url: 'https://example.test/doc', kind: 'link' }],
    })
  })
})

describe('writeModeOf', () => {
  it('writes through the gate only for a host ticket with writes open', () => {
    expect(writeModeOf('host', true)).toBe('gate')
    expect(writeModeOf('host', false)).toBe('none')
    expect(writeModeOf('fallback', true)).toBe('legacy')
    expect(writeModeOf('fallback', false, true)).toBe('none')
  })
})

describe('pagePrs', () => {
  it('joins the ticket, card and search PRs once each, with the freshest state', () => {
    const card = cardOf({
      key: 'ENG-1',
      pr: {
        repo: 'acme/app',
        number: 12,
        url: 'https://github.com/acme/app/pull/12',
        state: null,
        decision: null,
        checks: null,
      },
      ticket: ticketOf({
        prs: [
          {
            repo: 'acme/web',
            number: 12,
            url: 'https://github.com/acme/web/pull/12',
            title: 'Web side',
            state: 'merged',
            checks: 'pass',
            decision: null,
          },
        ],
      }),
    })
    const prs = pagePrs({
      key: 'ENG-1',
      detail: fromLinearTicket(LEGACY),
      card,
      hits: [],
    })
    expect(prs.map((p) => `${p.repo}#${p.number}:${p.state}`)).toEqual([
      'acme/app#12:null',
      'acme/web#12:merged',
    ])
  })
})
