import { describe, expect, it } from 'vitest'
import { ActivityItem, activitySections, ownedActive } from './activity'

const NOW = new Date(2026, 10, 4, 14, 0).getTime()

function item(over: Partial<ActivityItem> & Pick<ActivityItem, 'id'>): ActivityItem {
  return {
    kind: 'session',
    owner: 'assistant:nova',
    title: over.id,
    status: 'working',
    intent: '',
    startedAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    open: { to: 'chat', thread: `session:${over.id}`, session: over.id },
    ...over,
  }
}

describe('activitySections', () => {
  const rows = [
    item({ id: 'ask', owner: 'assistant:astra', status: 'waiting', intent: 'Which branch?', updatedAt: NOW - 5000 }),
    item({ id: 'ask-older', owner: 'session:x', status: 'waiting', updatedAt: NOW - 9000 }),
    item({ id: 'mine', kind: 'harness', open: { to: 'terminal', pane: 'w1:p3' }, startedAt: NOW - 1000 }),
    item({ id: 'canvas', kind: 'canvas', open: { to: 'canvas', slug: 'roadmap' } }),
    item({ id: 'helper', kind: 'helper', open: { to: 'subagent', file: '/s/h.jsonl', name: 'h' } }),
    item({ id: 'other-helper', kind: 'helper', owner: 'assistant:astra', open: { to: 'subagent', file: '/s/o.jsonl', name: 'o' } }),
    item({ id: 'polaris', owner: 'assistant:polaris' }),
    item({ id: 'loose', owner: 'other', kind: 'harness', open: { to: 'terminal', pane: 'w1:p9' } }),
    item({ id: 'self', open: { to: 'chat', thread: 'assistant:nova' } }),
    item({ id: 'done-today', status: 'done', updatedAt: NOW - 3_600_000 }),
    item({ id: 'done-yesterday', status: 'done', updatedAt: NOW - 30 * 3_600_000 }),
    item({ id: 'failed-today', status: 'failed', updatedAt: NOW - 600_000 }),
  ]

  it('pins what waits on Isaac on top, oldest ask first, from every owner', () => {
    expect(activitySections(rows, 'assistant:nova', NOW).waiting.map((i) => i.id)).toEqual(['ask-older', 'ask'])
  })

  it("lists this thread's own work (newest first) without its helpers, which the Artifacts rows draw, and without itself", () => {
    const s = activitySections(rows, 'assistant:nova', NOW)
    expect(s.mine.map((i) => i.id)).toEqual(['mine', 'canvas'])
  })

  it('groups the other owners, assistants first in the order given, loose ones last', () => {
    const s = activitySections(rows, 'assistant:nova', NOW, ['assistant:nova', 'assistant:astra', 'assistant:polaris'])
    expect(s.others.map((g) => [g.owner, g.items.map((i) => i.id)])).toEqual([
      ['assistant:astra', ['other-helper']],
      ['assistant:polaris', ['polaris']],
      ['other', ['loose']],
    ])
  })

  it('collapses what finished today under this thread, newest first, and drops yesterday', () => {
    expect(activitySections(rows, 'assistant:nova', NOW).earlier.map((i) => i.id)).toEqual(['failed-today', 'done-today'])
  })
})

describe('ownedActive', () => {
  it('is the in-progress items the thread owns, itself left out', () => {
    const list = [
      item({ id: 'a' }),
      item({ id: 'b', status: 'waiting' }),
      item({ id: 'c', status: 'done' }),
      item({ id: 'd', owner: 'assistant:astra' }),
      item({ id: 'self', open: { to: 'chat', thread: 'assistant:nova' } }),
    ]
    expect(ownedActive(list, 'assistant:nova').map((i) => i.id)).toEqual(['a', 'b'])
    expect(ownedActive(list, null)).toEqual([])
  })
})
