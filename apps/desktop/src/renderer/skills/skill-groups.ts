import type { SkillRow } from '@evaos/contract'
import { originOf, sortSkills, type SkillOrigin, type SkillSort } from './skills-model'

/**
 * Skill families for the table: skills that came from one place collapse into one expandable row.
 * A family is, in order of trust:
 *  1. a brand: the vendor whose package a skill was installed from (`cloudflare/skills`), or a
 *     name that is the vendor's (`cloudflare-one`), from the small BRANDS table below;
 *  2. a package: skills the host says came from one install source (a skills lock, a repo's or
 *     plugin's `skills/` folder);
 *  3. a name prefix: the first word of the name (`bambee-k8s`, `bambee-qa-team`).
 * Only two or more skills make a family; the rest stay plain rows. Families come from the whole
 * library, so a search or filter leaves a group's row on screen with just the members it matched.
 */

/** A vendor or topic that gets its own name (and logo, where the app has a real mark). */
interface Brand {
  id: string
  label: string
  /** The owner of a package (`cloudflare` for `cloudflare/skills`). */
  owners?: readonly string[]
  /** Names that belong to it without a package to say so. */
  names?: RegExp
}

const BRANDS: readonly Brand[] = [
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    owners: ['cloudflare'],
    names: /^cloudflare(?![a-z0-9])/,
  },
  { id: 'remotion', label: 'Remotion', owners: ['remotion-dev'], names: /^remotion(?![a-z0-9])/ },
  { id: 'polotno', label: 'Polotno', owners: ['polotno-project'], names: /^polotno(?![a-z0-9])/ },
  {
    // The OpenSEO skills carry no install source; their names are the only mark.
    id: 'seo',
    label: 'SEO',
    names:
      /^(seo|keyword|competitor|competitive|link-prospecting|local-seo|ai-visibility|ai-prompt)(?![a-z0-9])/,
  },
]

/** Where a skill's family came from. */
export type FamilyKind = 'brand' | 'package' | 'name'

export interface Family {
  /** Stable across lists: `brand:cloudflare`, `package:acme/skills`, `name:bambee`. */
  id: string
  label: string
  kind: FamilyKind
  /** The brand whose mark the group row shows (a key of the app's brand marks), when it has one. */
  brand: string | null
}

/** The skill's own name, without omp's `<source>/` prefix for a copy another source took the name of. */
function bareName(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1)
}

/** `bambee` from `bambee-k8s` and `unreal` from `unreal:blueprints`. */
function prefixOf(name: string): string {
  return bareName(name).split(/[-:]/)[0] ?? ''
}

const titleCase = (words: string): string =>
  words
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w, i) => (i === 0 ? `${w.charAt(0).toUpperCase()}${w.slice(1)}` : w))
    .join(' ')

/** `Cloudflare` from `cloudflare/skills`, `Earshot` from `earshot`, `Unreal engine` from `unreal-engine-skills-for-claude-code`. */
function packageLabel(pkg: string): string {
  const [owner = pkg, repo] = pkg.split('/')
  const word = repo === undefined || repo === 'skills' ? owner : repo
  return titleCase(word.replace(/-skills(-for-.+)?$/, '').replace(/-(dev|project|labs)$/, ''))
}

function brandOf(row: SkillRow): Brand | null {
  const owner = row.package?.split('/')[0]
  return (
    BRANDS.find(
      (b) =>
        (owner !== undefined && b.owners?.includes(owner)) || b.names?.test(bareName(row.name)),
    ) ?? null
  )
}

/** The words every name starts with, as the group's name: `dimensional-drawing`, `bambee`. */
function commonPrefix(names: readonly string[]): string {
  const split = names.map((n) => bareName(n).split(/[-:]/))
  const first = split[0] ?? []
  let at = 0
  while (at < first.length && split.every((w) => w[at] === first[at])) at++
  return first.slice(0, Math.max(at, 1)).join(' ')
}

/**
 * The family of each skill that has one (by name); a skill alone stays out. Brands and packages
 * claim first, then the leftovers pair up by name prefix.
 */
export function deriveFamilies(rows: readonly SkillRow[]): Map<string, Family> {
  const claimed = new Map<string, { family: Family; names: string[] }>()
  const first = (row: SkillRow): Family | null => {
    const brand = brandOf(row)
    if (brand)
      return { id: `brand:${brand.id}`, label: brand.label, kind: 'brand', brand: brand.id }
    if (row.package)
      return {
        id: `package:${row.package}`,
        label: packageLabel(row.package),
        kind: 'package',
        brand: null,
      }
    return null
  }
  for (const row of rows) {
    const family = first(row)
    if (!family) continue
    const group = claimed.get(family.id) ?? { family, names: [] }
    group.names.push(row.name)
    claimed.set(family.id, group)
  }
  const out = new Map<string, Family>()
  for (const { family, names } of claimed.values()) {
    if (names.length > 1) for (const name of names) out.set(name, family)
  }
  const byPrefix = new Map<string, string[]>()
  for (const row of rows) {
    const prefix = prefixOf(row.name)
    if (out.has(row.name) || prefix === '') continue
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), row.name])
  }
  for (const [prefix, names] of byPrefix) {
    if (names.length < 2) continue
    const family: Family = {
      id: `name:${prefix}`,
      label: titleCase(commonPrefix(names)),
      kind: 'name',
      brand: null,
    }
    for (const name of names) out.set(name, family)
  }
  return out
}

/** One family's row: its members (as shown now) and what they add up to. */
export interface SkillGroup {
  kind: 'group'
  family: Family
  members: SkillRow[]
  /** Loads across the members; null while none of them has a count. */
  uses: number | null
  /** The newest load of any member. */
  lastUsedAt: number | null
  /** The newest change in any member. */
  updatedAt: number
  /** The members' origin when they all share one. */
  origin: SkillOrigin | null
}

export type TableEntry = { kind: 'skill'; row: SkillRow } | SkillGroup

function summarize(family: Family, members: SkillRow[]): SkillGroup {
  const counted = members.filter((m) => typeof m.uses === 'number')
  const origins = new Set(members.map(originOf))
  const used = members.flatMap((m) => m.lastUsedAt ?? [])
  return {
    kind: 'group',
    family,
    members,
    uses: counted.length === 0 ? null : counted.reduce((n, m) => n + (m.uses ?? 0), 0),
    lastUsedAt: used.length === 0 ? null : Math.max(...used),
    updatedAt: Math.max(...members.map((m) => m.updatedAt)),
    origin: origins.size === 1 ? ([...origins][0] ?? null) : null,
  }
}

/** The table's rows for `shown` skills: each family one group row with its members sorted inside. */
export function groupSkills(
  shown: readonly SkillRow[],
  families: ReadonlyMap<string, Family>,
  sort: SkillSort,
): TableEntry[] {
  const members = new Map<string, { family: Family; rows: SkillRow[] }>()
  const entries: TableEntry[] = []
  for (const row of shown) {
    const family = families.get(row.name)
    if (!family) {
      entries.push({ kind: 'skill', row })
      continue
    }
    const group = members.get(family.id) ?? { family, rows: [] }
    group.rows.push(row)
    members.set(family.id, group)
  }
  for (const { family, rows } of members.values())
    entries.push(summarize(family, sortSkills(rows, sort)))
  const sign = sort.dir === 'asc' ? 1 : -1
  const name = (e: TableEntry): string => (e.kind === 'group' ? e.family.label : e.row.name)
  const value = (e: TableEntry): number => {
    const at = e.kind === 'group' ? e : e.row
    if (sort.key === 'uses') return at.uses ?? -1
    if (sort.key === 'lastUsed') return at.lastUsedAt ?? 0
    return at.updatedAt
  }
  return entries.sort((a, b) => {
    const by = sort.key === 'name' ? name(a).localeCompare(name(b)) : value(a) - value(b)
    return by === 0 ? name(a).localeCompare(name(b)) : by * sign
  })
}

/** The skills drawn, top to bottom: a collapsed group's members are not. */
export function visibleSkills(
  entries: readonly TableEntry[],
  isOpen: (groupId: string) => boolean,
): SkillRow[] {
  return entries.flatMap((e) =>
    e.kind === 'skill' ? [e.row] : isOpen(e.family.id) ? e.members : [],
  )
}
