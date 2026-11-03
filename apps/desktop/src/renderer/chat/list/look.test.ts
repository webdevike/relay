import { describe, expect, it } from 'vitest'
import {
  FAST_SETTLE_MS,
  FOLDER_SHOWN,
  age,
  bright,
  elapsed,
  fastSettles,
  folderShown,
  folders,
  hint,
  lookStatus,
  modelName,
  pill,
  projectColor,
  projectInitials,
  snoozeOptions,
  split,
  workLabel,
} from './look'
import { chatRow } from './test-rows'

const S = 1000
const H = 3600 * S

describe('lookStatus', () => {
  it('ranks a dialog over everything, then failed, working, monitoring, woke, unread', () => {
    const unread = { openedMs: null }
    expect(lookStatus(chatRow('a', 'x', { status: 'needs-approval', failed: true }))).toBe(
      'approval',
    )
    expect(lookStatus(chatRow('a', 'x', { status: 'has-question' }))).toBe('asked')
    expect(lookStatus(chatRow('a', 'x', { failed: true, ...unread }))).toBe('failed')
    expect(lookStatus(chatRow('a', 'x', { failed: true }))).toBeNull()
    const working = { running: true, status: 'working' as const, startedMs: 5 }
    expect(lookStatus(chatRow('a', 'x', working))).toBe('working')
    // Replying wins over open jobs; idle with jobs is Monitoring.
    expect(lookStatus(chatRow('a', 'x', { ...working, jobs: 2 }))).toBe('working')
    expect(lookStatus(chatRow('a', 'x', { running: true, status: 'job', jobs: 1 }))).toBe(
      'monitoring',
    )
    expect(lookStatus(chatRow('a', 'x', { running: false, jobs: 1 }))).toBeNull()
    expect(lookStatus(chatRow('a', 'x', { wokeMs: 3, ...unread }))).toBe('woke')
    expect(lookStatus(chatRow('a', 'x', unread))).toBe('done')
    expect(lookStatus(chatRow('a', 'x', { openedMs: 999 }))).toBe('done')
    expect(lookStatus(chatRow('a', 'x'))).toBeNull()
  })
})

describe('pill, elapsed and age', () => {
  it('writes native strings', () => {
    expect(pill('working', 0, 16 * S)).toBe('Working 16s')
    expect(pill('working', 0, 125 * S)).toBe('Working 2m')
    expect(pill('approval', 0, 0)).toBe('Approval')
    expect(pill('asked', 0, 0)).toBe('Input')
    expect(pill('done', 0, 0)).toBe('Done')
    expect(elapsed(0, 2 * H + 5)).toBe('2h')
    expect(elapsed(10, 0)).toBe('0s')
    expect(age(0, 59 * S)).toBe('now')
    expect(age(0, 18 * 60 * S)).toBe('18m')
    expect(age(0, 21 * H)).toBe('21h')
    expect(age(0, 3 * 24 * H)).toBe('3d')
  })
})

describe('bright and fastSettles', () => {
  const now = 10 * H
  const idle = { returnedMs: now - FAST_SETTLE_MS, openedMs: now - FAST_SETTLE_MS }

  it('is bright when it needs Isaac, is unread, or woke', () => {
    expect(bright(chatRow('a', 'x'))).toBe(false)
    expect(bright(chatRow('a', 'x', { openedMs: null }))).toBe(true)
    expect(bright(chatRow('a', 'x', { wokeMs: 1 }))).toBe(true)
    expect(bright(chatRow('a', 'x', { status: 'has-question' }))).toBe(true)
  })

  it('settles a read chat idle for four hours since return or kept', () => {
    expect(fastSettles(chatRow('a', 'x', idle), now)).toBe(true)
    expect(
      fastSettles(chatRow('a', 'x', { ...idle, returnedMs: now - FAST_SETTLE_MS + 1 }), now),
    ).toBe(false)
    expect(fastSettles(chatRow('a', 'x', { ...idle, keptMs: now - 1 }), now)).toBe(false)
    expect(fastSettles(chatRow('a', 'x', { ...idle, openedMs: null }), now)).toBe(false)
    expect(fastSettles(chatRow('a', 'x', { ...idle, pinned: true }), now)).toBe(false)
    expect(fastSettles(chatRow('a', 'x', { ...idle, wokeMs: 1 }), now)).toBe(false)
    expect(fastSettles(chatRow('a', 'x', { ...idle, snoozedUntilMs: now + 1 }), now)).toBe(false)
    expect(fastSettles(chatRow('a', 'x', { ...idle, status: 'has-question' }), now)).toBe(false)
    expect(
      fastSettles(
        chatRow('a', 'x', { ...idle, running: true, status: 'working', startedMs: 1 }),
        now,
      ),
    ).toBe(false)
  })
})

describe('split and folders', () => {
  const now = 5 * H
  const rows = [
    chatRow('old', 'Relay old', { returnedMs: now - 10 * S }),
    chatRow('pin', 'Pinned', { pinned: true, returnedMs: now - 1 }),
    chatRow('arch', 'Archived', { archived: true, returnedMs: now - 2 * S }),
    chatRow('arch2', 'Archived newer', { archived: true, pinned: true, returnedMs: now - S }),
    chatRow('fast', 'Fast', { returnedMs: 0, openedMs: 0 }),
    chatRow('sn2', 'Snoozed later', { snoozedUntilMs: now + 2 * H }),
    chatRow('sn1', 'Snoozed sooner', { snoozedUntilMs: now + H, pinned: true }),
    chatRow('new', 'Relay new', { returnedMs: now - 5 * S }),
    chatRow('ecard', 'eCard thing', { returnedMs: now - 7 * S, status: 'has-question' }),
    chatRow('work', 'Plain', {
      returnedMs: now - 20 * S,
      running: true,
      status: 'working',
      startedMs: 1,
    }),
  ]
  const lists = split(rows, now)

  it('puts settled before snoozed before pinned, each in native order', () => {
    expect(lists.settled.map((r) => r.id)).toEqual(['arch2', 'arch', 'fast'])
    expect(lists.snoozed.map((r) => r.id)).toEqual(['sn1', 'sn2'])
    expect(lists.pinned.map((r) => r.id)).toEqual(['pin'])
    expect(lists.list.map((r) => r.id)).toEqual(['new', 'ecard', 'old', 'work'])
  })

  it('groups by category, newest folder first, with the most urgent hint', () => {
    const category = (r: { title: string }) =>
      r.title.startsWith('Relay') ? 'Relay' : r.title.startsWith('eCard') ? 'eCard' : 'Other'
    const out = folders(lists.list, category)
    expect(out.map((f) => [f.name, f.rows.map((r) => r.id), f.hint])).toEqual([
      ['Relay', ['new', 'old'], null],
      ['eCard', ['ecard'], 'asked'],
      ['Other', ['work'], 'working'],
    ])
  })

  it('hint prefers approval over question over working', () => {
    const working = chatRow('w', 'x', { running: true, status: 'working', startedMs: 1 })
    const asked = chatRow('q', 'x', { status: 'has-question' })
    const approval = chatRow('p', 'x', { status: 'needs-approval' })
    expect(hint([working, asked])).toBe('asked')
    expect(hint([asked, approval, working])).toBe('approval')
    expect(hint([chatRow('d', 'x', { openedMs: null }), working])).toBe('working')
  })

  it('caps a folder at ten unless searching or shown more', () => {
    expect(FOLDER_SHOWN).toBe(10)
    expect(folderShown(14, false, false)).toBe(10)
    expect(folderShown(14, true, false)).toBe(14)
    expect(folderShown(14, false, true)).toBe(14)
    expect(folderShown(3, false, false)).toBe(3)
  })
})

describe('project badge', () => {
  it('reads two letters as native project_initials', () => {
    expect(projectInitials('OpenFlight')).toBe('OF')
    expect(projectInitials('Texo')).toBe('TE')
    expect(projectInitials('my side project')).toBe('MS')
    expect(projectInitials('Other')).toBe('OT')
  })
  it('hashes the name with FNV-1a 64 onto five chart colors', () => {
    expect(projectColor('Other')).toBe(1)
    expect(projectColor('Hexagon')).toBe(4)
    expect(projectColor('Focus')).toBe(3)
  })
})

describe('workLabel', () => {
  it('leads with the key unless the branch names it', () => {
    expect(workLabel({ key: 'ENG-8', branch: 'fix/ENG-8-y', pr: 1 })).toBe('fix/ENG-8-y')
    expect(workLabel({ key: 'ENG-1', branch: 'feat/x', pr: null })).toBe('ENG-1 · feat/x')
    expect(workLabel({ key: 'ENG-42', branch: null, pr: null })).toBe('ENG-42')
    expect(workLabel({ key: null, branch: 'main', pr: null })).toBe('main')
    expect(workLabel({ key: null, branch: null, pr: 5 })).toBeNull()
    expect(workLabel(null)).toBeNull()
  })
})

describe('modelName', () => {
  it('reads model ids as people write them', () => {
    for (const [raw, name] of [
      ['anthropic/claude-opus-5-5', 'Claude Opus 5.5'],
      ['claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5'],
      ['claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet'],
      ['openai/gpt-5.6-sol', 'GPT-5.6 Sol'],
      ['openai-codex/gpt-6-astra', 'GPT-6 Astra'],
      ['gpt-4o-mini', 'GPT-4o Mini'],
      ['o3', 'o3'],
      ['google/gemini-2.5-pro', 'Gemini 2.5 Pro'],
    ]) {
      expect(modelName(raw!), raw).toBe(name)
    }
  })
})

describe('snoozeOptions', () => {
  const show = (d: Date) => snoozeOptions(d).map((o) => [o.label, o.when])

  it('follows the default digests (native snooze_times_follow_the_digests)', () => {
    expect(show(new Date(2026, 9, 14, 10, 0))).toEqual([
      ['In 1 hour', 'Today 11:00'],
      ['Next digest', 'Today 13:00'],
      ['Evening digest', 'Today 17:30'],
      ['Tomorrow morning digest', 'Thu Oct 15 08:30'],
      ['Monday', 'Mon Oct 19 08:30'],
    ])
    expect(show(new Date(2026, 9, 14, 18, 0))).toEqual([
      ['In 1 hour', 'Today 19:00'],
      ['Next digest', 'Thu Oct 15 08:30'],
      ['Monday', 'Mon Oct 19 08:30'],
    ])
    expect(show(new Date(2026, 9, 19, 9, 0)).at(-1)).toEqual(['Monday', 'Mon Oct 26 08:30'])
    expect(show(new Date(2026, 9, 18, 9, 0)).some(([l]) => l === 'Monday')).toBe(false)
    const until = snoozeOptions(new Date(2026, 9, 14, 10, 0)).map((o) => o.untilMs)
    expect(until).toEqual([...until].sort((a, b) => a - b))
  })
})
