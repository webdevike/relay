import { describe, expect, it } from 'vitest'
import { Categories } from './categories'

describe('Categories', () => {
  it('keeps moved chats where they were put while their category exists (ported Rust test)', () => {
    const cats = Categories.fromPrefs({
      chat_categories: ['Errands'],
      chat_assignments: { a: 'Errands', b: 'Gone' },
    })
    expect(cats.categoryOf('a', 'Fix Relay pairing', null)).toBe('Errands')
    expect(cats.categoryOf('b', 'Fix Relay pairing', null)).toBe('Relay')
    expect(cats.categoryOf('none', 'Fix Relay pairing', null)).toBe('Relay')
  })

  it('falls back to where the chat worked only when its title names no workspace', () => {
    const cats = Categories.fromPrefs({
      chat_categories: ['Errands'],
      chat_assignments: { a: 'Errands', b: 'Gone' },
    })
    // An existing assignment wins over the title and the work.
    expect(cats.categoryOf('a', 'Fix Relay pairing', 'eCard')).toBe('Errands')
    // A title naming a workspace wins over the work.
    expect(cats.categoryOf('none', 'Fix Relay pairing', 'eCard')).toBe('Relay')
    // A title naming none: the work, else Other; a stale assignment is ignored.
    expect(cats.categoryOf('b', 'Tidy the garage', 'eCard')).toBe('eCard')
    expect(cats.categoryOf('none', 'Tidy the garage', null)).toBe('Other')
  })

  it('fromPrefs ignores bad entries and toPrefs round-trips', () => {
    const bad = { chat_categories: ['A', 3, null], chat_assignments: { x: 'A', y: 5 } }
    const cats = Categories.fromPrefs(bad as never)
    expect(cats.toPrefs()).toEqual({
      chat_categories: ['A'],
      chat_group_order: [],
      chat_assignments: { x: 'A' },
    })
    expect(Categories.fromPrefs(cats.toPrefs()).toPrefs()).toEqual(cats.toPrefs())
    expect(Categories.fromPrefs(null).names().at(-1)).toBe('Other')
  })

  it('add validates, pushes to custom and fronts the order', () => {
    const cats = Categories.fromPrefs({})
    expect(cats.add('  ')).toEqual({ ok: false, error: 'Give the category a name.' })
    expect(cats.add(' Errands ')).toEqual({ ok: true })
    expect(cats.add('errands')).toEqual({
      ok: false,
      error: 'A category with that name already exists.',
    })
    expect(cats.add('RELAY')).toEqual({
      ok: false,
      error: 'A category with that name already exists.',
    })
    cats.add('Home')
    expect(cats.toPrefs().chat_categories).toEqual(['Errands', 'Home'])
    expect(cats.toPrefs().chat_group_order).toEqual(['Home', 'Errands'])
    expect(cats.names().slice(0, 2)).toEqual(['Home', 'Errands'])
    expect(cats.isCustom('Home')).toBe(true)
    expect(cats.isCustom('Relay')).toBe(false)
  })

  it('rename is custom only and rewrites order and assignments', () => {
    const cats = Categories.fromPrefs({
      chat_categories: ['Errands'],
      chat_group_order: ['Errands'],
      chat_assignments: { a: 'Errands' },
    })
    expect(cats.rename('Relay', 'X')).toEqual({
      ok: false,
      error: 'Only your own categories can be renamed.',
    })
    expect(cats.rename('Errands', 'Chores')).toEqual({ ok: true })
    expect(cats.toPrefs()).toEqual({
      chat_categories: ['Chores'],
      chat_group_order: ['Chores'],
      chat_assignments: { a: 'Chores' },
    })
  })

  it('remove drops the category, order entry and assignments', () => {
    const cats = Categories.fromPrefs({
      chat_categories: ['Errands'],
      chat_group_order: ['Errands'],
      chat_assignments: { a: 'Errands', b: 'Relay' },
    })
    cats.remove('Errands')
    expect(cats.exists('Errands')).toBe(false)
    expect(cats.toPrefs().chat_assignments).toEqual({ b: 'Relay' })
  })

  it('assign sets and clears', () => {
    const cats = Categories.fromPrefs({})
    cats.assign('a', 'Relay')
    expect(cats.categoryOf('a', 'Grocery', null)).toBe('Relay')
    cats.assign('a', null)
    expect(cats.categoryOf('a', 'Grocery', null)).toBe('Other')
  })

  it('names orders saved order, then custom, then workspaces', () => {
    const cats = Categories.fromPrefs({
      chat_categories: ['Errands', 'Home'],
      chat_group_order: ['Relay', 'Gone', 'Errands'],
    })
    const names = cats.names()
    expect(names.slice(0, 3)).toEqual(['Relay', 'Errands', 'Home'])
    expect(names).not.toContain('Gone')
    expect(names.at(-1)).toBe('Other')
    expect(cats.rank('Relay')).toBe(0)
    expect(cats.rank('Nope')).toBeGreaterThan(100)
  })
})
