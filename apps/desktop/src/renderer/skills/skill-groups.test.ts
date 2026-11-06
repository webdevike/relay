import type { SkillRow } from '@evaos/contract'
import { describe, expect, it } from 'vitest'
import { deriveFamilies, groupSkills, visibleSkills, type TableEntry } from './skill-groups'
import { DEFAULT_SORT, type SkillSort } from './skills-model'

const source = {
  key: 'agents:user',
  label: 'Agents',
  dir: '~/.agents/skills/x',
  file: '/x/SKILL.md',
}
const row = (name: string, over: Partial<SkillRow> = {}): SkillRow => ({
  name,
  description: '',
  source,
  also: [],
  updatedAt: 0,
  usedBy: [],
  disabled: false,
  lastUsedAt: null,
  uses: 0,
  ...over,
})
const pkg = (name: string, p: string, over: Partial<SkillRow> = {}): SkillRow =>
  row(name, { package: p, ...over })

const LIBRARY = [
  pkg('cloudflare', 'cloudflare/skills'),
  pkg('wrangler', 'cloudflare/skills'),
  pkg('k2', 'cloudflare/skills'),
  pkg('remotion-docs', 'remotion-dev/skills'),
  pkg('remotion-saas', 'remotion-dev/skills'),
  pkg('polotno-sdk', 'polotno-project/skills'),
  pkg('polotno-design', 'polotno-project/skills'),
  pkg('typesafe-ai', 'typesafe-ai/skills'),
  pkg('earshot', 'earshot'),
  pkg('real-sound', 'earshot'),
  row('seo-audit'),
  row('keyword-research'),
  row('competitor-analysis'),
  row('link-prospecting'),
  row('ai-visibility-audit'),
  row('dimensional-drawing'),
  row('dimensional-drawing-motion'),
  row('bambee-k8s'),
  row('bambee-qa-team'),
  row('raea'),
  row('raea-bevy'),
  row('canvas'),
  row('work'),
]
const familyOf = (name: string): string | undefined => deriveFamilies(LIBRARY).get(name)?.id

describe('deriveFamilies', () => {
  it('groups skills installed from one package under the vendor, and names the vendor', () => {
    const f = deriveFamilies(LIBRARY)
    expect(f.get('wrangler')).toEqual({
      id: 'brand:cloudflare',
      label: 'Cloudflare',
      kind: 'brand',
      brand: 'cloudflare',
    })
    expect(familyOf('k2')).toBe('brand:cloudflare')
    expect(familyOf('remotion-saas')).toBe('brand:remotion')
    expect(f.get('polotno-sdk')?.label).toBe('Polotno')
    // A package nobody gave a brand is named from its folder or repo.
    expect(
      deriveFamilies([
        pkg('a-1', 'unreal-engine-skills-for-claude-code'),
        pkg('b-1', 'unreal-engine-skills-for-claude-code'),
      ]).get('a-1')?.label,
    ).toBe('Unreal engine')
    expect(f.get('earshot')).toMatchObject({ id: 'package:earshot', label: 'Earshot', brand: null })
  })

  it("claims a vendor's skills by name when the host has no package for them", () => {
    const f = deriveFamilies([row('cloudflare-one'), row('cloudflare-email-service')])
    expect([...f.values()].map((x) => x.id)).toEqual(['brand:cloudflare', 'brand:cloudflare'])
  })

  it('collects the OpenSEO skills as SEO, and the rest by shared name prefix', () => {
    for (const n of ['seo-audit', 'keyword-research', 'competitor-analysis', 'link-prospecting'])
      expect(familyOf(n)).toBe('brand:seo')
    expect(familyOf('ai-visibility-audit')).toBe('brand:seo')
    expect(deriveFamilies(LIBRARY).get('dimensional-drawing-motion')).toMatchObject({
      id: 'name:dimensional',
      label: 'Dimensional drawing',
    })
    expect(familyOf('dimensional-drawing')).toBe('name:dimensional')
    expect(familyOf('bambee-qa-team')).toBe('name:bambee')
    expect(familyOf('raea-bevy')).toBe('name:raea')
  })

  it('leaves a skill alone when nothing else shares its package, brand or prefix', () => {
    for (const n of ['typesafe-ai', 'canvas', 'work']) expect(familyOf(n)).toBeUndefined()
  })

  it('lets a skill alone in its package join the name prefix family it shares', () => {
    const f = deriveFamilies([pkg('acme-one', 'acme/skills'), row('acme-two')])
    expect(f.get('acme-one')?.id).toBe('name:acme')
    expect(f.get('acme-two')?.id).toBe('name:acme')
  })

  it('reads omp collision names and plugin names by their own word', () => {
    const f = deriveFamilies([
      row('agents/hallmark'),
      row('hallmark'),
      row('unreal:a'),
      row('unreal:b'),
    ])
    expect(f.get('agents/hallmark')?.id).toBe('name:hallmark')
    expect(f.get('unreal:b')?.id).toBe('name:unreal')
  })

  it('has no families without the host naming packages when names do not repeat', () => {
    expect(deriveFamilies([row('canvas'), row('work'), row('modernize')]).size).toBe(0)
  })
})

describe('groupSkills', () => {
  const shown = [
    pkg('cloudflare', 'cloudflare/skills', { uses: 5, lastUsedAt: 300, updatedAt: 10 }),
    pkg('wrangler', 'cloudflare/skills', { uses: 20, lastUsedAt: 100, updatedAt: 90 }),
    pkg('k2', 'cloudflare/skills', { uses: null }),
    row('canvas', { uses: 12, lastUsedAt: 50, updatedAt: 40 }),
    row('bambee-k8s', { uses: 1, updatedAt: 5 }),
    row('bambee-qa-team', { uses: 2, updatedAt: 6 }),
  ]
  const families = deriveFamilies(shown)
  const label = (e: TableEntry): string => (e.kind === 'group' ? e.family.label : e.row.name)
  const run = (sort: SkillSort): TableEntry[] => groupSkills(shown, families, sort)

  it('adds a group up: count, uses, newest load, newest change, shared origin', () => {
    const cf = run(DEFAULT_SORT).find((e) => label(e) === 'Cloudflare')
    expect(cf).toMatchObject({
      kind: 'group',
      uses: 25,
      lastUsedAt: 300,
      updatedAt: 90,
      origin: 'omp',
    })
    expect(cf?.kind === 'group' && cf.members.map((m) => m.name)).toEqual([
      'cloudflare',
      'k2',
      'wrangler',
    ])
  })

  it('says nothing for uses until some member has a count, and no origin when they differ', () => {
    const f = deriveFamilies([
      row('x-a', { uses: undefined }),
      row('x-b', { uses: undefined, origin: 'both' }),
    ])
    const [g] = groupSkills(
      [row('x-a', { uses: undefined }), row('x-b', { uses: undefined, origin: 'both' })],
      f,
      DEFAULT_SORT,
    )
    expect(g).toMatchObject({ uses: null, origin: null })
  })

  it('sorts groups among plain rows by name, and members inside', () => {
    expect(run(DEFAULT_SORT).map(label)).toEqual(['Bambee', 'canvas', 'Cloudflare'])
  })

  it('sorts groups by their total uses, newest load or newest change; members by the same', () => {
    const uses = run({ key: 'uses', dir: 'desc' })
    expect(uses.map(label)).toEqual(['Cloudflare', 'canvas', 'Bambee'])
    const cf = uses[0]
    expect(cf?.kind === 'group' && cf.members.map((m) => m.name)).toEqual([
      'wrangler',
      'cloudflare',
      'k2',
    ])
    expect(run({ key: 'lastUsed', dir: 'desc' }).map(label)).toEqual([
      'Cloudflare',
      'canvas',
      'Bambee',
    ])
    expect(run({ key: 'updated', dir: 'asc' }).map(label)).toEqual([
      'Bambee',
      'canvas',
      'Cloudflare',
    ])
  })

  it('shows only the members it is given, keeping the group', () => {
    const [g] = groupSkills([shown[1]!], families, DEFAULT_SORT)
    expect(g).toMatchObject({ kind: 'group', uses: 20 })
    expect(g?.kind === 'group' && g.members).toHaveLength(1)
  })
})

describe('visibleSkills', () => {
  it('lists plain rows and the members of open groups, in drawn order', () => {
    const shown = [row('a-1'), row('a-2'), row('solo')]
    const entries = groupSkills(shown, deriveFamilies(shown), DEFAULT_SORT)
    expect(visibleSkills(entries, () => false).map((r) => r.name)).toEqual(['solo'])
    expect(visibleSkills(entries, (id) => id === 'name:a').map((r) => r.name)).toEqual([
      'a-1',
      'a-2',
      'solo',
    ])
  })
})
