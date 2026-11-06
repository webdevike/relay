import type { SkillAssistant, SkillRow, SkillSource } from '@evaos/contract'
import { describe, expect, it } from 'vitest'
import {
  ANY,
  DEFAULT_SORT,
  accessChange,
  filterSkills,
  joinTitles,
  lastUsedLabel,
  nextSort,
  originOf,
  scopeAccess,
  scopeOf,
  sharedProfiles,
  sizeLabel,
  sortSkills,
  sourceLabels,
  sourcePill,
  updatedLabel,
} from './skills-model'

const src = (label: string): SkillSource => ({
  key: label === 'Eva' ? 'eva' : 'agents',
  label,
  dir: `~/${label}/skills/x`,
  file: `/Users/i/${label}/skills/x/SKILL.md`,
})
const row = (name: string, over: Partial<SkillRow> = {}): SkillRow => ({
  name,
  description: `${name} things`,
  source: src('Eva'),
  also: [],
  updatedAt: 0,
  usedBy: ['nova'],
  disabled: false,
  lastUsedAt: null,
  ...over,
})

const ROWS = [
  row('canvas', { description: 'Build and open boards on the EvaOS Canvas.', updatedAt: 30 }),
  row('adhd', { description: 'Parallel divergent ideation', updatedAt: 10, usedBy: [] }),
  row('cloudflare', { source: src('.agents'), also: [src('.claude')], updatedAt: 20 }),
]
const all = { query: '', source: ANY, origin: ANY, usedBy: ANY }

describe('origin', () => {
  const claude = { ...src('Claude project'), key: 'claude:project' }
  it("reads the host's origin, else the source: claude:* is Claude, anything else omp", () => {
    expect(originOf(row('a', { origin: 'both', source: claude }))).toBe('both')
    expect(originOf(row('a', { source: claude }))).toBe('claude')
    expect(originOf(row('a'))).toBe('omp')
  })

  it('filters by origin', () => {
    const rows = [
      row('a', { origin: 'omp' }),
      row('b', { origin: 'claude' }),
      row('c', { origin: 'both' }),
    ]
    expect(filterSkills(rows, { ...all, origin: 'claude' }).map((r) => r.name)).toEqual(['b'])
    expect(filterSkills(rows, { ...all, origin: 'both' }).map((r) => r.name)).toEqual(['c'])
    expect(filterSkills(rows, all)).toHaveLength(3)
  })
})

describe('filterSkills', () => {
  it('matches every word in the name or description, any case', () => {
    expect(filterSkills(ROWS, { ...all, query: 'BOARDS evaos' }).map((r) => r.name)).toEqual([
      'canvas',
    ])
    expect(filterSkills(ROWS, { ...all, query: 'cloud' }).map((r) => r.name)).toEqual([
      'cloudflare',
    ])
    expect(filterSkills(ROWS, { ...all, query: '  ' })).toHaveLength(3)
    expect(filterSkills(ROWS, { ...all, query: 'nothing here' })).toEqual([])
  })

  it('filters by source label and by assistant', () => {
    expect(filterSkills(ROWS, { ...all, source: '.agents' }).map((r) => r.name)).toEqual([
      'cloudflare',
    ])
    expect(filterSkills(ROWS, { ...all, usedBy: 'nova' }).map((r) => r.name)).toEqual([
      'canvas',
      'cloudflare',
    ])
  })
})

describe('sortSkills', () => {
  it('sorts by name by default and by updated either way', () => {
    expect(sortSkills(ROWS, DEFAULT_SORT).map((r) => r.name)).toEqual([
      'adhd',
      'canvas',
      'cloudflare',
    ])
    expect(sortSkills(ROWS, { key: 'name', dir: 'desc' }).map((r) => r.name)).toEqual([
      'cloudflare',
      'canvas',
      'adhd',
    ])
    expect(sortSkills(ROWS, { key: 'updated', dir: 'desc' }).map((r) => r.name)).toEqual([
      'canvas',
      'cloudflare',
      'adhd',
    ])
    expect(sortSkills(ROWS, { key: 'updated', dir: 'asc' })[0]!.name).toBe('adhd')
  })

  it('does not reorder the input and breaks ties by name', () => {
    const tied = [row('b', { updatedAt: 1 }), row('a', { updatedAt: 1 })]
    expect(sortSkills(tied, { key: 'updated', dir: 'desc' }).map((r) => r.name)).toEqual(['a', 'b'])
    expect(tied[0]!.name).toBe('b')
  })

  it('flips the same column and starts another at its natural order', () => {
    expect(nextSort(DEFAULT_SORT, 'name')).toEqual({ key: 'name', dir: 'desc' })
    expect(nextSort(DEFAULT_SORT, 'updated')).toEqual({ key: 'updated', dir: 'desc' })
    expect(nextSort({ key: 'updated', dir: 'desc' }, 'name')).toEqual(DEFAULT_SORT)
  })
})

describe('labels', () => {
  it('names sources with extra copies', () => {
    expect(sourcePill(ROWS[0]!)).toBe('Eva')
    expect(sourcePill(ROWS[2]!)).toBe('.agents +1')
    expect(sourceLabels(ROWS)).toEqual(['Eva', '.agents'])
  })

  it('ages by calendar day', () => {
    const now = new Date(2026, 10, 5, 15).getTime()
    expect(updatedLabel(new Date(2026, 10, 5, 1).getTime(), now)).toBe('today')
    expect(updatedLabel(new Date(2026, 10, 4, 23).getTime(), now)).toBe('1d ago')
    expect(updatedLabel(new Date(2026, 9, 22).getTime(), now)).toBe('2w ago')
    expect(updatedLabel(new Date(2026, 6, 1).getTime(), now)).toBe('4mo ago')
  })

  it('sizes files', () => {
    expect(sizeLabel(312)).toBe('312 B')
    expect(sizeLabel(4200)).toBe('4.2 KB')
  })

  it('says when it was last used', () => {
    const now = 1_000_000_000
    expect(lastUsedLabel(now - 10_000, now)).toBe('just now')
    expect(lastUsedLabel(now - 60_000, now)).toBe('1 minute ago')
    expect(lastUsedLabel(now - 2 * 3_600_000, now)).toBe('2 hours ago')
    expect(lastUsedLabel(now - 3 * 86_400_000, now)).toBe('3 days ago')
  })

  it('joins titles', () => {
    expect(joinTitles(['Nova'])).toBe('Nova')
    expect(joinTitles(['Nova', 'Polaris'])).toBe('Nova and Polaris')
    expect(joinTitles(['Nova', 'Astra', 'Polaris'])).toBe('Nova, Astra and Polaris')
  })
})

describe('shared profiles', () => {
  const assistants: SkillAssistant[] = [
    { id: 'nova', title: 'Nova', profile: 'personal', color: '#f76707' },
    { id: 'astra', title: 'Astra', profile: 'work', color: '#228be6' },
    { id: 'polaris', title: 'Polaris', profile: 'personal', color: '#7950f2' },
  ]
  const profiles = { nova: 'personal', astra: 'work', polaris: 'personal' }

  it('moves assistants on the same profile together', () => {
    expect(accessChange(assistants, profiles, 'nova', false)).toEqual({
      nova: false,
      polaris: false,
    })
    expect(accessChange(assistants, profiles, 'astra', true)).toEqual({ astra: true })
    expect(accessChange(assistants, { ...profiles, astra: null }, 'astra', true)).toEqual({
      astra: true,
    })
  })

  it('names the groups that share a profile', () => {
    expect(sharedProfiles(assistants, profiles)).toEqual([['personal', ['Nova', 'Polaris']]])
  })

  it('reads the scope from who loads it, profile mates counting as one', () => {
    expect(scopeOf([], assistants, profiles)).toBeNull()
    expect(scopeOf(['astra'], assistants, profiles)).toEqual({ kind: 'one', id: 'astra' })
    expect(scopeOf(['nova', 'polaris'], assistants, profiles)).toEqual({ kind: 'one', id: 'nova' })
    expect(scopeOf(['nova', 'astra'], assistants, profiles)).toEqual({ kind: 'global' })
    expect(scopeOf(['nova', 'astra', 'polaris'], assistants, profiles)).toEqual({
      kind: 'global',
    })
  })

  it('turns a scope into access for every assistant', () => {
    expect(scopeAccess({ kind: 'global' }, assistants, profiles)).toEqual({
      nova: true,
      astra: true,
      polaris: true,
    })
    expect(scopeAccess({ kind: 'one', id: 'astra' }, assistants, profiles)).toEqual({
      nova: false,
      astra: true,
      polaris: false,
    })
  })
})
