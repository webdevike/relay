import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn(async (..._a: unknown[]) => ({ ok: true, value: {} }))
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))

import {
  defaultPrefs,
  dropNode,
  favId,
  inOrder,
  isShown,
  moveId,
  parsePrefs,
  resetSidebarPrefsForTests,
  sidebarPrefsStore,
  type FavFolder,
  type FavItem,
  type FavNode,
} from './sidebar-prefs'

const item = (page: FavItem['page'], chat: string | null = null): FavItem => ({
  kind: 'item',
  id: favId(page, chat),
  page,
  chat,
  title: page,
  icon: 'IconStar',
})
const folder = (id: string, items: FavItem[] = []): FavFolder => ({
  kind: 'folder',
  id,
  name: id,
  open: true,
  items,
})
const ids = (nodes: readonly FavNode[]): unknown[] =>
  nodes.map((n) => (n.kind === 'folder' ? [n.id, n.items.map((i) => i.id)] : n.id))

beforeEach(() => {
  invoke.mockClear()
  resetSidebarPrefsForTests()
})

describe('parsePrefs', () => {
  it('falls back to defaults for anything unusable', () => {
    expect(parsePrefs(null)).toEqual(defaultPrefs())
    expect(parsePrefs([])).toEqual(defaultPrefs())
    expect(
      parsePrefs({ badgeStyle: 'huge', visibility: { a: 'sometimes' }, order: { main: 3 } }),
    ).toEqual(defaultPrefs())
  })

  it('keeps valid settings and drops malformed favorites', () => {
    const jobs = item('jobs')
    const parsed = parsePrefs({
      badgeStyle: 'dot',
      visibility: { jobs: 'badged', habits: 'never', x: 'nope' },
      order: { main: ['jobs', 4, 'habits'] },
      collapsed: { dashboards: true, main: false },
      favorites: [
        jobs,
        jobs,
        { kind: 'item', id: 'bad', page: 'not-a-page', chat: null, title: 't', icon: 'i' },
        { kind: 'folder', id: 'f', name: 'Work', open: false, items: [jobs, item('habits')] },
        'junk',
      ],
    })
    expect(parsed.badgeStyle).toBe('dot')
    expect(parsed.visibility).toEqual({ jobs: 'badged', habits: 'never' })
    expect(parsed.order).toEqual({ main: ['jobs', 'habits'] })
    expect(parsed.collapsed).toEqual({ dashboards: true })
    expect(ids(parsed.favorites)).toEqual([jobs.id, ['f', [item('habits').id]]])
    expect((parsed.favorites[1] as FavFolder).open).toBe(false)
  })
})

describe('ordering and visibility helpers', () => {
  it('orders by the saved order and appends rows it has not met', () => {
    const rows = ['a', 'b', 'c', 'd'].map((id) => ({ id }))
    expect(inOrder(rows, ['c', 'a', 'gone']).map((r) => r.id)).toEqual(['c', 'a', 'b', 'd'])
    expect(inOrder(rows, undefined).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('moves an id to where another is, either direction', () => {
    expect(moveId(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a'])
    expect(moveId(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
    expect(moveId(['a', 'b'], 'a', 'zzz')).toEqual(['a', 'b'])
  })

  it('shows badged rows only while they carry a badge', () => {
    expect(isShown(undefined, false)).toBe(true)
    expect(isShown('always', false)).toBe(true)
    expect(isShown('badged', false)).toBe(false)
    expect(isShown('badged', true)).toBe(true)
    expect(isShown('never', true)).toBe(false)
  })
})

describe('the store', () => {
  it('saves every change to layout.json under sidebar', () => {
    sidebarPrefsStore.getState().setVisibility('jobs', 'never')
    expect(invoke).toHaveBeenLastCalledWith('layout.save', {
      sidebar: expect.objectContaining({ visibility: { jobs: 'never' } }),
    })
    // Always show is the default, so it leaves no key behind.
    sidebarPrefsStore.getState().setVisibility('jobs', 'always')
    expect(sidebarPrefsStore.getState().visibility).toEqual({})
    sidebarPrefsStore.getState().setBadgeStyle('none')
    sidebarPrefsStore.getState().setOrder('main', ['jobs', 'chat'])
    sidebarPrefsStore.getState().toggleCollapsed('main')
    expect(invoke).toHaveBeenLastCalledWith('layout.save', {
      sidebar: {
        badgeStyle: 'none',
        visibility: {},
        order: { main: ['jobs', 'chat'] },
        collapsed: { main: true },
        favorites: [],
      },
    })
    sidebarPrefsStore.getState().toggleCollapsed('main')
    expect(sidebarPrefsStore.getState().collapsed).toEqual({})
  })

  it('favorites a page once, groups it in a folder and spills it back on delete', () => {
    const s = sidebarPrefsStore.getState()
    s.addFavorite({ page: 'jobs', chat: null, title: 'Jobs', icon: 'IconCalendarTime' })
    s.addFavorite({ page: 'jobs', chat: null, title: 'Jobs', icon: 'IconCalendarTime' })
    s.addFavorite({ page: 'chat', chat: '/s/a.jsonl', title: 'A chat', icon: 'IconMessage' })
    expect(sidebarPrefsStore.getState().favorites).toHaveLength(2)
    const f = s.addFolder('Work')
    s.moveToFolder(favId('jobs', null), f)
    expect(ids(sidebarPrefsStore.getState().favorites)).toEqual([
      favId('chat', '/s/a.jsonl'),
      [f, [favId('jobs', null)]],
    ])
    s.renameFolder(f, 'Ops')
    s.toggleFolder(f)
    expect((sidebarPrefsStore.getState().favorites[1] as FavFolder).name).toBe('Ops')
    expect((sidebarPrefsStore.getState().favorites[1] as FavFolder).open).toBe(false)
    s.deleteFolder(f)
    expect(ids(sidebarPrefsStore.getState().favorites)).toEqual([
      favId('chat', '/s/a.jsonl'),
      favId('jobs', null),
    ])
    s.removeFavorite(favId('jobs', null))
    expect(sidebarPrefsStore.getState().favorites).toHaveLength(1)
  })
})

describe('dropNode', () => {
  const a = item('jobs')
  const b = item('habits')
  const c = item('studio')
  const d = item('rooms')

  it('reorders top-level favorites like an array move', () => {
    expect(ids(dropNode([a, b, c], a.id, c.id))).toEqual([b.id, c.id, a.id])
    expect(ids(dropNode([a, b, c], c.id, a.id))).toEqual([c.id, a.id, b.id])
  })

  it('drops a favorite onto a folder to join it, and out of one onto a favorite', () => {
    const f = folder('f', [b])
    expect(ids(dropNode([a, f], a.id, 'f'))).toEqual([['f', [b.id, a.id]]])
    expect(ids(dropNode([a, f], b.id, a.id))).toEqual([b.id, a.id, ['f', []]])
  })

  it('reorders inside a folder and moves between folders', () => {
    const f = folder('f', [a, b, c])
    expect(ids(dropNode([f], a.id, c.id))).toEqual([['f', [b.id, c.id, a.id]]])
    const g = folder('g', [d])
    expect(ids(dropNode([f, g], a.id, d.id))).toEqual([
      ['f', [b.id, c.id]],
      ['g', [a.id, d.id]],
    ])
  })

  it('moves folders among the top level only', () => {
    const f = folder('f', [b])
    expect(ids(dropNode([f, a], 'f', a.id))).toEqual([a.id, ['f', [b.id]]])
    expect(ids(dropNode([a, f, c], 'f', a.id))).toEqual([['f', [b.id]], a.id, c.id])
  })
})
