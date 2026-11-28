import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FILTERS,
  DEFAULT_HIDDEN,
  agoLabel,
  byColumn,
  footLabel,
  freshnessLabel,
  parseHidden,
  visibleCards,
  waitingCount,
  waitingOf,
} from './board-view'
import { NOW, cardOf, ticketOf, waitingFrom } from './test-cards'

const cards = [
  cardOf({
    key: 'ENG-1',
    title: 'Fix versions',
    agent: 'Astra',
    column: 'needs',
    ticket: ticketOf({ waiting: waitingFrom('Chris Doe') }),
  }),
  cardOf({ key: 'ENG-2', title: 'Old thing', agent: 'Astra', stale: true }),
  cardOf({
    key: 'ENG-3',
    title: 'Ship the report',
    kind: 'ticket',
    column: 'review',
    ticket: ticketOf({
      needsYou: {
        kind: 'merge',
        text: 'Ready to merge',
        action: { kind: 'merge', label: 'Merge', pr: null },
        evidence: 'sha',
      },
    }),
  }),
  cardOf({ key: 'ENG-4', title: 'Done already', column: 'done', ticket: ticketOf() }),
  cardOf({
    id: 'run:helper',
    kind: 'helper',
    title: 'AgentKanban',
    session: 'BoardProto',
    agent: 'Nova',
    column: 'working',
  }),
]

describe('board view', () => {
  it('hides Done by default and keeps only known columns from a saved list', () => {
    expect(DEFAULT_HIDDEN).toEqual(['done'])
    expect(parseHidden(['qa', 'nope', 'done', 'qa'])).toEqual(['qa', 'done'])
    expect(parseHidden([])).toEqual([])
    expect(parseHidden('done')).toBeNull()
  })

  it('never shows stale cards, and searches key, title, session and agent', () => {
    const keys = (f = DEFAULT_FILTERS): Array<string | null> =>
      visibleCards(cards, f).map((c) => c.key ?? c.id)
    expect(keys()).toEqual(['ENG-1', 'ENG-3', 'ENG-4', 'run:helper'])
    expect(keys({ ...DEFAULT_FILTERS, query: 'eng-1 fix' })).toEqual(['ENG-1'])
    expect(keys({ ...DEFAULT_FILTERS, query: 'boardproto' })).toEqual(['run:helper'])
    expect(keys({ ...DEFAULT_FILTERS, query: 'nova' })).toEqual(['run:helper'])
    // A stale card stays hidden even when the search names it.
    expect(keys({ ...DEFAULT_FILTERS, query: 'old thing' })).toEqual([])
  })

  it('Waiting on you keeps waiting mentions and Needs you cards, and counts them', () => {
    const waitingOnly = { ...DEFAULT_FILTERS, waitingOnly: true }
    expect(visibleCards(cards, waitingOnly).map((c) => c.key)).toEqual(['ENG-1', 'ENG-3'])
    expect(waitingCount(cards)).toBe(2)
    expect(
      waitingCount([
        ...cards,
        cardOf({ key: 'ENG-9', stale: true, ticket: ticketOf({ waiting: waitingFrom('A') }) }),
      ]),
    ).toBe(2)
  })

  it('hides a mention marked handled here until a newer comment comes', () => {
    const card = cards[0]!
    const w = card.ticket!.waiting!
    expect(waitingOf(card, new Set())).toBe(w)
    expect(waitingOf(card, new Set(['linear:ENG-1:c-1']))).toBeNull()
    const newer = cardOf({ ticket: ticketOf({ waiting: waitingFrom('Chris Doe', 'c-2') }) })
    expect(waitingOf(newer, new Set(['linear:ENG-1:c-1']))).not.toBeNull()
  })

  it('counts cards per column, placing a card mid-move where it is going', () => {
    const shown = visibleCards(cards, DEFAULT_FILTERS)
    const cols = byColumn(shown)
    expect(Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, v.length]))).toEqual({
      queued: 0,
      working: 1,
      needs: 1,
      review: 1,
      qa: 0,
      done: 1,
    })
    const moved = byColumn(shown, (id) => (id === 'item:ENG-4' ? 'working' : null))
    expect(moved.working.map((c) => c.key)).toEqual(['ENG-4', null])
    expect(moved.done).toEqual([])
  })

  it('says when: created for a ticket, updated for a run, synced for the board', () => {
    expect(footLabel(cards[0]!, NOW)).toBe('Created Nov 1')
    expect(footLabel(cardOf({ activityAt: NOW - 14 * 60_000 }), NOW)).toBe('Updated 14m ago')
    expect(footLabel(cardOf({ activityAt: NOW }), NOW)).toBe('Updated just now')
    expect(footLabel(cardOf({}), NOW)).toBeNull()
    const host = {
      source: 'host' as const,
      reason: null,
      message: null,
      lastSyncAt: NOW - 2 * 60_000,
      writes: true,
      syncAs: 'Isaac Weber (eCard), GitHub webdevike',
    }
    expect(freshnessLabel(host, NOW)).toBe('Synced 2m ago')
    expect(freshnessLabel({ ...host, lastSyncAt: NOW }, NOW)).toBe('Synced just now')
    expect(freshnessLabel({ ...host, lastSyncAt: null }, NOW)).toBe('Syncing')
    expect(
      freshnessLabel(
        { ...host, source: 'fallback', reason: 'oldHost', message: 'The host has no Linear sync' },
        NOW,
      ),
    ).toBe('The host has no Linear sync')
  })

  it('says how long ago in a few characters', () => {
    expect(agoLabel(null, NOW)).toBe('')
    expect(agoLabel(NOW - 30_000, NOW)).toBe('now')
    expect(agoLabel(NOW - 5 * 60_000, NOW)).toBe('5m')
    expect(agoLabel(NOW - 3 * 3_600_000, NOW)).toBe('3h')
    expect(agoLabel(NOW - 3 * 86_400_000, NOW)).toBe('3d')
    expect(agoLabel(NOW - 21 * 86_400_000, NOW)).toBe('3w')
  })
})
