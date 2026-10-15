import { describe, expect, it } from 'vitest'
import { Categories } from './categories'
import {
  groupChats,
  isRecentlyActive,
  RECENT_CHATS,
  RECENTLY_ACTIVE_MS,
  type ListRow,
} from './chat-groups'

let n = 0
function row(title: string, mtimeMs: number, extra: Partial<ListRow> = {}): ListRow {
  n += 1
  return {
    id: `id${n}`,
    file: `/s/t_id${n}.jsonl`,
    title,
    mtimeMs,
    running: false,
    pinned: false,
    archived: false,
    ...extra,
  }
}

const none = new Set<string>()
const browse = { query: '', collapsed: none, expanded: none }

function fixture(): ListRow[] {
  const rows: ListRow[] = [
    row('eCard report one', 100),
    row('eCard report two', 200),
    row('Relay airplay drop', 300),
    row('Relay pairing', 150, { running: true }),
    row('EvaOS gpui list', 400),
    row('Pinned relay thing', 50, { pinned: true }),
    row('Old relay archived', 10, { archived: true }),
  ]
  for (let i = 0; i < 7; i++) rows.push(row(`Grocery ${i}`, 1000 + i))
  rows[rows.length - 1] = { ...rows[rows.length - 1]!, id: 'moved' }
  return rows
}

describe('groupChats browsing', () => {
  const cats = Categories.fromPrefs({
    chat_categories: ['Errands', 'Empty'],
    chat_assignments: { moved: 'Errands' },
  })
  const view = groupChats(fixture(), cats, browse)

  it('puts pinned on top and out of groups', () => {
    expect(view.pinned.map((r) => r.title)).toEqual(['Pinned relay thing'])
    const relay = view.groups.find((g) => g.name === 'Relay')!
    expect(relay.rows.map((r) => r.title)).not.toContain('Pinned relay thing')
  })

  it('keeps archived rows in the bottom list only', () => {
    expect(view.archived.map((r) => r.title)).toEqual(['Old relay archived'])
    expect(view.groups.flatMap((g) => g.rows).some((r) => r.archived)).toBe(false)
  })

  it('orders groups by category names, custom first, empty custom shown', () => {
    const names = view.groups.map((g) => g.name)
    expect(names.slice(0, 2)).toEqual(['Errands', 'Empty'])
    expect(names).toContain('Empty')
    expect(names.indexOf('eCard')).toBeLessThan(names.indexOf('Relay'))
    expect(names.at(-1)).toBe('Other')
    expect(names).not.toContain('Texo')
    expect(view.groups.find((g) => g.name === 'Empty')!.total).toBe(0)
  })

  it('puts running first, then newest, inside a group', () => {
    const relay = view.groups.find((g) => g.name === 'Relay')!
    expect(relay.rows.map((r) => r.title)).toEqual(['Relay pairing', 'Relay airplay drop'])
    expect(relay.runningCount).toBe(1)
  })

  it('shows five recent and Show 2 more for seven Other chats', () => {
    const other = view.groups.find((g) => g.name === 'Other')!
    expect(other.total).toBe(6)
    const cats2 = Categories.fromPrefs({})
    const v2 = groupChats(fixture(), cats2, browse)
    const o2 = v2.groups.find((g) => g.name === 'Other')!
    expect(o2.total).toBe(7)
    expect(o2.rows).toHaveLength(RECENT_CHATS)
    expect(o2.hidden).toBe(2)
    expect(o2.rows[0]!.title).toBe('Grocery 6')
  })

  it('expanded shows all with no hidden', () => {
    const v = groupChats(fixture(), Categories.fromPrefs({}), {
      ...browse,
      expanded: new Set(['Other']),
    })
    const o = v.groups.find((g) => g.name === 'Other')!
    expect(o.rows).toHaveLength(7)
    expect(o.hidden).toBe(0)
  })

  it('running chats extend the visible count', () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(`Misc ${i}`, i, { running: i < 2 }))
    const g = groupChats(rows, Categories.fromPrefs({}), browse).groups[0]!
    expect(g.rows).toHaveLength(7)
    expect(g.hidden).toBe(1)
  })

  it('collapsed groups keep counts but hide rows', () => {
    const v = groupChats(fixture(), cats, { ...browse, collapsed: new Set(['Relay']) })
    const relay = v.groups.find((g) => g.name === 'Relay')!
    expect(relay.collapsed).toBe(true)
    expect(relay.total).toBe(2)
    expect(relay.runningCount).toBe(1)
    expect(relay.rows).toEqual([])
    expect(relay.hidden).toBe(0)
  })
})

describe('groupChats searching', () => {
  const cats = Categories.fromPrefs({ chat_categories: ['Errands'] })
  const v = groupChats(fixture(), cats, {
    query: '  RELAY ',
    collapsed: new Set(['Relay']),
    expanded: none,
  })

  it('includes archived, ignores collapsed, drops empty groups', () => {
    expect(v.searching).toBe(true)
    expect(v.groups.map((g) => g.name)).toEqual(['Relay'])
    const relay = v.groups[0]!
    expect(relay.collapsed).toBe(false)
    expect(relay.hidden).toBe(0)
    expect(relay.rows.map((r) => r.title)).toContain('Old relay archived')
    expect(relay.rows.find((r) => r.archived)).toBeTruthy()
  })

  it('filters pinned and empties the archived list', () => {
    expect(v.pinned.map((r) => r.title)).toEqual(['Pinned relay thing'])
    expect(v.archived).toEqual([])
    const none2 = groupChats(fixture(), cats, { ...browse, query: 'grocery 3' })
    expect(none2.pinned).toEqual([])
    expect(none2.groups).toHaveLength(1)
  })

  it('opens every group fully with many matches', () => {
    const g = groupChats(fixture(), Categories.fromPrefs({}), { ...browse, query: 'grocery' })
      .groups[0]!
    expect(g.rows).toHaveLength(7)
    expect(g.hidden).toBe(0)
  })
})

describe('isRecentlyActive', () => {
  it('uses a ten minute window', () => {
    const now = 10_000_000
    expect(RECENTLY_ACTIVE_MS).toBe(600_000)
    expect(isRecentlyActive(now - 599_999, now)).toBe(true)
    expect(isRecentlyActive(now - 600_001, now)).toBe(false)
  })
})
