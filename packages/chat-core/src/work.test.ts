import { describe, expect, it } from 'vitest'
import {
  frontmatter,
  isTicket,
  keysIn,
  ledgerFor,
  parseWorkLink,
  prFromUrl,
  resolveWorkLine,
  workLabel,
  workLineOf,
  type Place,
  type WorkLink,
} from './work'

const link = (o: Partial<WorkLink> & { key: string }): WorkLink => ({
  linear: null,
  pr: null,
  branch: null,
  worktree: null,
  title: null,
  ...o,
})
const place = (o: Partial<Place>): Place => ({
  cwd: null,
  active: null,
  activeBranch: null,
  cwdBranch: null,
  eva: false,
  ...o,
})

describe('ledgers (ported from links.rs)', () => {
  it('finds ticket keys at word boundaries', () => {
    expect(keysIn('ENG-6227 render helper, see ENG-6180 and ENG-6227')).toEqual([
      'ENG-6227',
      'ENG-6180',
    ])
    expect(keysIn('style/ENG-6243-oxlint-layout')).toEqual(['ENG-6243'])
    expect(keysIn('work/react-client-reports-app-ENG-6257')).toEqual(['ENG-6257'])
    expect(keysIn('UTF-8 and SHA-256, ENGINE-3, ENG-, XENG-12')).toEqual([])
    expect(isTicket('ENG-6227')).toBe(true)
    expect(isTicket('ENG-6227 extra')).toBe(false)
  })

  it('reads pull request urls', () => {
    expect(prFromUrl('https://github.com/eCardSystems/react-client-reports-app/pull/213')).toEqual({
      repo: 'eCardSystems/react-client-reports-app',
      number: 213,
    })
    expect(prFromUrl('https://github.com/a/b/pull/7#discussion')).toEqual({
      repo: 'a/b',
      number: 7,
    })
    expect(prFromUrl('https://github.com/a/b/issues/4')).toBeNull()
    expect(prFromUrl('In Progress')).toBeNull()
  })

  it('reads only the frontmatter, skipping nested keys', () => {
    const fields = frontmatter('---\nkey: ENG-1\nmove: isaac\n  nested: x\n---\nmove: no\n')
    expect(fields.get('move')).toBe('isaac')
    expect(fields.get('nested')).toBeUndefined()
    expect(frontmatter('# title\nmove: isaac').size).toBe(0)
  })

  it('parses a ledger', () => {
    const text =
      '---\nkey: ENG-6227\nlinear: https://linear.app/ecard-systems/issue/ENG-6227\nworktree: work/wt\nbranch: refactor/ENG-6227-test-render-helper\npr: https://github.com/eCardSystems/react-client-reports-app/pull/213\ntitle: [eCard] Render helper\n---\nbody'
    const l = parseWorkLink('ENG-6227', text, '/repo')
    expect(l).toEqual({
      key: 'ENG-6227',
      linear: 'ENG-6227',
      pr: { repo: 'eCardSystems/react-client-reports-app', number: 213 },
      branch: 'refactor/ENG-6227-test-render-helper',
      worktree: '/repo/work/wt',
      title: 'Render helper',
    })
    // A ledger with nothing to join on, or only a shared branch, is skipped.
    expect(parseWorkLink('x', '---\nbranch: main\nlinear: In Progress\n---', '/')).toBeNull()
    expect(parseWorkLink('y', '---\nworktree: /abs/wt\n---', '/repo')?.worktree).toBe('/abs/wt')
  })

  it("finds a session's ledger by worktree, then ticket", () => {
    const work = [
      link({ key: 'ENG-1', linear: 'ENG-1', worktree: '/repo/work/wt-a' }),
      link({ key: 'ENG-2', linear: 'ENG-2' }),
    ]
    const found = (cwd: string | null, title: string) => ledgerFor(work, cwd, title)?.key ?? null
    expect(found('/repo/work/wt-a/src', 'ENG-2 fix')).toBe('ENG-1')
    expect(found('/repo/work/wt-ab', 'Untitled')).toBeNull()
    expect(found('/repo', 'Fix ENG-2 sorting')).toBe('ENG-2')
    expect(found('/repo/work/x-ENG-2', 'Untitled')).toBe('ENG-2')
    expect(found('/repo', 'ENG-9 unknown')).toBeNull()
    expect(found(null, 'Nothing')).toBeNull()
  })
})

describe('work lines (ported from look.rs)', () => {
  it('prefer the ledger, then the title and branch', () => {
    const ledger = link({
      key: 'ENG-6227',
      branch: 'refactor/ENG-6227-test-render-helper',
      pr: { repo: 'a/b', number: 213 },
    })
    const line = workLineOf(ledger, 'anything', 'main')!
    expect(line.pr).toBe(213)
    expect(workLabel(line)).toBe('refactor/ENG-6227-test-render-helper')
    expect(workLabel(workLineOf(link({ key: 'ENG-1' }), 'x', 'feat/x')!)).toBe('ENG-1 · feat/x')
    expect(workLabel(workLineOf(null, 'Fix ENG-42 sorting', null)!)).toBe('ENG-42')
    expect(workLabel(workLineOf(null, 'Plain', 'main')!)).toBe('main')
    expect(workLineOf(null, 'Plain', null)).toBeNull()
  })

  it("hide the Eva checkout's main but show its other branches", () => {
    const eva = place({ cwd: '/Users/ike/Eva', cwdBranch: 'main', eva: true })
    expect(resolveWorkLine(eva, 'Plain', [])).toBeNull()
    expect(resolveWorkLine(eva, 'Fix ENG-9', [])).toEqual({ key: 'ENG-9', branch: null, pr: null })
    const label = (p: Place) => {
      const line = resolveWorkLine(p, 'Plain', [])
      return line && workLabel(line)
    }
    expect(label({ ...eva, cwdBranch: 'feat/thing' })).toBe('feat/thing')
    expect(label({ ...eva, eva: false })).toBe('main')
  })

  it("name an active worktree by its ledger, else its folder's key and branch", () => {
    const gone = '/e/work/gone-ENG-8'
    const ledger = link({
      key: 'ENG-8',
      branch: 'fix/ENG-8-y',
      pr: { repo: 'a/b', number: 88 },
      worktree: gone,
    })
    expect(resolveWorkLine(place({ active: gone }), 'Plain', [ledger])).toEqual({
      key: 'ENG-8',
      branch: 'fix/ENG-8-y',
      pr: 88,
    })
    // A ledger that dropped its worktree after merging still names it by its key.
    expect(
      resolveWorkLine(place({ active: gone }), 'Plain', [{ ...ledger, worktree: null }])?.pr,
    ).toBe(88)
    const line = resolveWorkLine(
      place({ active: '/e/work/app-ENG-5', activeBranch: 'fix/sorting' }),
      'Plain',
      [],
    )!
    expect(workLabel(line)).toBe('ENG-5 · fix/sorting')
  })

  it('a branchless ledger does not claim a shared checkout on main', () => {
    const relay = '/e/work/relay'
    const ledger = link({ key: 'relay-recipe-widget', worktree: relay })
    const label = (activeBranch: string) => {
      const line = resolveWorkLine(place({ active: relay, activeBranch }), 'Plain', [ledger])
      return line && workLabel(line)
    }
    expect(label('main')).toBe('main')
    expect(label('feat/widget')).toBe('relay-recipe-widget · feat/widget')
  })
})
