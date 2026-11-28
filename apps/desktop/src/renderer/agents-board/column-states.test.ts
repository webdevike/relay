import { describe, expect, it } from 'vitest'
import type { AgentCard } from '@evaos/contract'
import { staysPut, targetState, type TeamState } from './column-states'

const S = (id: string, name: string, type: string): TeamState => ({ id, name, type })
const ENG: TeamState[] = [
  S('backlog', 'Backlog', 'backlog'),
  S('todo', 'Todo', 'unstarted'),
  S('progress', 'In Progress', 'started'),
  S('design', 'Design Review', 'started'),
  S('review', 'In Review', 'started'),
  S('qa', 'In QA', 'started'),
  S('done', 'Done', 'completed'),
  S('canceled', 'Canceled', 'canceled'),
]

const card = (over: Partial<AgentCard> = {}): AgentCard => ({
  id: 'ticket:ENG-1',
  kind: 'ticket',
  key: 'ENG-1',
  title: 'T',
  column: 'queued',
  pill: { label: 'Todo', tone: 'default' },
  reason: 'Todo in Linear',
  workspace: null,
  agent: null,
  session: null,
  intent: null,
  stage: null,
  move: null,
  next: null,
  phase: null,
  pr: null,
  linear: { key: 'ENG-1', url: null, state: 'Todo', stateType: 'unstarted' },
  activityAt: 1,
  stale: false,
  links: [],
  ticket: {
    id: 'issue-1',
    state: { id: 'todo', name: 'Todo', type: 'unstarted', color: '#fff' },
    team: { id: 'team-eng', key: 'ENG' },
    priority: 0,
    project: null,
    milestone: null,
    labels: [],
    parent: null,
    sub: null,
    assignee: null,
    createdAt: 1,
    updatedAt: 1,
    prs: [],
    waiting: null,
    needsYou: null,
  },
  openTarget: { kind: 'ticket', key: 'ENG-1' },
  dragBlock: null,
  ...over,
})

describe('targetState', () => {
  it('maps each column to its state by exact name', () => {
    const name = (c: Parameters<typeof targetState>[0]) => {
      const t = targetState(c, ENG, 'backlog')
      return t.kind === 'state' ? t.name : t.kind
    }
    expect(name('queued')).toBe('Todo')
    expect(name('working')).toBe('In Progress')
    expect(name('needs')).toBe('Design Review')
    expect(name('review')).toBe('In Review')
    expect(name('qa')).toBe('In QA')
    expect(name('done')).toBe('Done')
  })

  it('falls back to the one state of the column’s type, else asks or says none', () => {
    const custom = [
      S('a', 'Ready', 'unstarted'),
      S('b', 'Doing', 'started'),
      S('c', 'Shipped', 'completed'),
    ]
    expect(targetState('queued', custom, 'x')).toMatchObject({ kind: 'state', id: 'a' })
    expect(targetState('working', custom, 'x')).toMatchObject({ kind: 'state', id: 'b' })
    expect(targetState('done', custom, 'x')).toMatchObject({ kind: 'state', id: 'c' })
    const two = [...custom, S('d', 'Building', 'started')]
    expect(targetState('working', two, 'x')).toEqual({
      kind: 'ambiguous',
      options: [S('b', 'Doing', 'started'), S('d', 'Building', 'started')],
    })
    expect(targetState('qa', custom, 'x')).toMatchObject({ kind: 'none' })
    expect(targetState('needs', custom, 'x').kind).toBe('none')
  })

  it('writes nothing when the card is already in that state', () => {
    expect(targetState('working', ENG, 'progress')).toEqual({
      kind: 'none',
      message: "It's already In Progress",
    })
  })
})

describe('staysPut', () => {
  const state = (id: string) => ENG.find((s) => s.id === id)!

  it('lets a synced issue move where its new state places it', () => {
    expect(staysPut(card(), 'working', state('progress'))).toBeNull()
    expect(staysPut(card(), 'done', state('canceled'))).toBeNull()
    expect(staysPut(card(), 'needs', state('design'))).toBeNull()
    expect(staysPut(card(), 'qa', state('qa'))).toBeNull()
  })

  it('keeps a synced issue with an open PR in review', () => {
    const pr = {
      repo: 'o/r',
      number: 9,
      url: 'https://github.com/o/r/pull/9',
      title: 'p',
      state: 'open' as const,
      checks: 'pass' as const,
      decision: null,
    }
    const withPr = card({ ticket: { ...card().ticket!, prs: [pr] } })
    expect(staysPut(withPr, 'working', state('progress'))).toBe(
      'This card stays in In review: PR #9 is open',
    )
    expect(staysPut(withPr, 'review', state('review'))).toBeNull()
  })

  it('refuses an agent-driven card and one with no Linear issue', () => {
    const driven = card({ dragBlock: 'Astra is working on this; the column follows her run' })
    expect(staysPut(driven, 'done', state('done'))).toBe(
      'This card stays in Queued: Astra is working on this; the column follows her run',
    )
    expect(staysPut(card({ ticket: null }), 'working', state('progress'))).toContain(
      'No Linear issue',
    )
  })

  it('keeps an agent card where its agent facts put it, unless Linear decides', () => {
    const needs = card({ kind: 'item', column: 'needs', reason: 'Pick a design' })
    expect(staysPut(needs, 'working', state('progress'))).toBe(
      'This card stays in Needs Isaac: Pick a design',
    )
    expect(staysPut(needs, 'done', state('done'))).toBeNull()
    const queued = card({ kind: 'item', column: 'queued' })
    expect(staysPut(queued, 'review', state('review'))).toBeNull()
    expect(staysPut(queued, 'working', state('progress'))).toContain('stays in Queued')
  })
})
