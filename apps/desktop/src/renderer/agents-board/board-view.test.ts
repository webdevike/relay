import { describe, expect, it } from 'vitest'
import type { AgentCard } from '@evaos/contract'
import { DEFAULT_FILTERS, agoLabel, byColumn, lanesOf, optionsOf, visibleCards } from './board-view'

const card = (over: Partial<AgentCard>): AgentCard => ({
  id: over.key ? `item:${over.key}` : 'run:x',
  kind: 'item',
  key: null,
  title: 'A card',
  column: 'queued',
  pill: { label: 'Queued', tone: 'default' },
  reason: '',
  workspace: null,
  agent: null,
  session: null,
  intent: null,
  stage: null,
  move: null,
  next: null,
  phase: null,
  pr: null,
  linear: null,
  activityAt: null,
  stale: false,
  links: [],
  ...over,
})

const cards = [
  card({
    key: 'ENG-1',
    title: 'Fix versions',
    agent: 'Astra',
    workspace: 'ecardsystems',
    column: 'needs',
  }),
  card({
    key: 'ENG-2',
    title: 'Old thing',
    agent: 'Astra',
    workspace: 'ecardsystems',
    stale: true,
  }),
  card({
    key: 'relay-rooms',
    title: 'Rooms',
    agent: 'Nova',
    workspace: 'eva-interface',
    column: 'review',
  }),
  card({ id: 'run:helper', title: 'AgentKanban', session: 'AgentKanban', column: 'working' }),
]

describe('board view', () => {
  it('hides stale cards unless asked, and filters by agent, workspace and words', () => {
    expect(visibleCards(cards, DEFAULT_FILTERS).map((c) => c.title)).toEqual([
      'Fix versions',
      'Rooms',
      'AgentKanban',
    ])
    expect(visibleCards(cards, { ...DEFAULT_FILTERS, showStale: true })).toHaveLength(4)
    expect(visibleCards(cards, { ...DEFAULT_FILTERS, agent: 'Nova' }).map((c) => c.key)).toEqual([
      'relay-rooms',
    ])
    expect(visibleCards(cards, { ...DEFAULT_FILTERS, workspace: 'ecardsystems' })).toHaveLength(1)
    expect(
      visibleCards(cards, { ...DEFAULT_FILTERS, query: 'eng-1 fix' }).map((c) => c.key),
    ).toEqual(['ENG-1'])
  })

  it('splits cards into columns and lanes', () => {
    const cols = byColumn(cards)
    expect(cols.needs).toHaveLength(1)
    expect(cols.done).toEqual([])
    expect(lanesOf(cards, 'none')).toHaveLength(1)
    expect(lanesOf(cards, 'agent').map((l) => l.title)).toEqual(['Astra', 'Nova', 'No agent'])
    expect(optionsOf(cards, 'workspace')).toEqual(['ecardsystems', 'eva-interface'])
  })

  it('says how long ago in a few characters', () => {
    const now = Date.parse('2026-11-09T12:00:00Z')
    expect(agoLabel(null, now)).toBe('')
    expect(agoLabel(now - 30_000, now)).toBe('now')
    expect(agoLabel(now - 5 * 60_000, now)).toBe('5m')
    expect(agoLabel(now - 3 * 3_600_000, now)).toBe('3h')
    expect(agoLabel(now - 3 * 86_400_000, now)).toBe('3d')
    expect(agoLabel(now - 21 * 86_400_000, now)).toBe('3w')
  })
})
