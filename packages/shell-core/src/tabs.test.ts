import { describe, expect, it } from 'vitest'
import { placeOf, type PageKey, type Place } from './place'
import {
  HISTORY,
  activeTab,
  back,
  closeActive,
  closeOthers,
  closeTab,
  createTabs,
  defaultTabs,
  forkTab,
  forward,
  loadTabs,
  navigate,
  openNewChat,
  saveTabs,
  switchTo,
  togglePin,
  type Tabs,
} from './tabs'

const p = (page: PageKey): Place => placeOf(page)

/** Tabs at `places`, `pinned` of them pinned, the first active. */
function at(places: Place[], pinned = 0): Tabs {
  return createTabs(
    places.map((here, id) => ({ id, here, back: [], forward: [], pinned: id < pinned })),
    0,
  )
}
const heres = (t: Tabs) => t.list.map((x) => x.here.page)
const activate = (t: Tabs, ix: number): Tabs => switchTo(t, t.list[ix].id)

describe('tabs', () => {
  it('navigating to a place open elsewhere switches to it', () => {
    let tabs = at([p('dashboard'), p('jobs')])
    tabs = navigate(tabs, p('jobs'))
    expect(tabs.active).toBe(1)
    expect(heres(tabs)).toEqual(['dashboard', 'jobs'])
    expect(tabs.list[0].back).toEqual([])
    tabs = at([p('jobs'), placeOf('chat', { chat: '/s/a.jsonl' })])
    tabs = navigate(tabs, placeOf('chat', { chat: '/s/a.jsonl' }))
    expect(tabs.active).toBe(1)
    tabs = at([p('jobs'), p('chat')])
    tabs = navigate(tabs, p('chat'))
    expect(tabs.active).toBe(0)
    expect(tabs.list[0].back).toEqual([p('jobs')])
  })

  it('a new tab for a place open elsewhere gives way to it', () => {
    let tabs = at([p('dashboard'), p('jobs')])
    tabs = navigate(forkTab(tabs), p('jobs'))
    expect(heres(tabs)).toEqual(['dashboard', 'jobs'])
    expect(tabs.active).toBe(1)
    tabs = navigate(forkTab(tabs), p('habits'))
    expect(heres(tabs)).toEqual(['dashboard', 'jobs', 'habits'])
    expect(tabs.active).toBe(2)
    // Rust still records the forked place as history.
    expect(tabs.list[2].back).toEqual([p('jobs')])
  })

  it('a pinned tab stays put', () => {
    let tabs = at([p('dashboard'), p('jobs')], 1)
    tabs = navigate(tabs, p('habits'))
    expect(heres(tabs)).toEqual(['dashboard', 'habits', 'jobs'])
    expect(tabs.active).toBe(1)
    expect(tabs.list[0].back).toEqual([])
    expect(tabs.list[1].pinned).toBe(false)
    tabs = navigate(activate(tabs, 0), p('jobs'))
    expect(tabs.active).toBe(2)
    expect(tabs.list).toHaveLength(3)
    expect(tabs.list[0].here).toEqual(p('dashboard'))
    const same = navigate(activate(tabs, 0), p('dashboard'))
    expect(same.list).toHaveLength(3)
    expect(same.active).toBe(0)
  })

  it('pinning keeps pinned tabs first', () => {
    let tabs = at([p('dashboard'), p('jobs'), p('habits')])
    tabs = activate(tabs, 1)
    tabs = togglePin(tabs, 2)
    expect(heres(tabs)).toEqual(['habits', 'dashboard', 'jobs'])
    expect(tabs.active).toBe(2)
    tabs = togglePin(tabs, tabs.list[2].id)
    expect(heres(tabs)).toEqual(['habits', 'jobs', 'dashboard'])
    tabs = togglePin(tabs, tabs.list[0].id)
    expect(heres(tabs)).toEqual(['jobs', 'habits', 'dashboard'])
    expect(tabs.active).toBe(0)
  })

  it('saved tabs load pinned first', () => {
    const base = at([p('jobs'), p('habits')]).list
    base[1].pinned = true
    const tabs = createTabs(base, 0)
    expect(heres(tabs)).toEqual(['habits', 'jobs'])
    expect(tabs.active).toBe(1)
  })

  it('keeps 50 history entries, back and forward step, navigate clears forward', () => {
    let tabs = at([p('dashboard')])
    const pages: PageKey[] = ['jobs', 'habits']
    for (let i = 0; i < 51; i++) tabs = navigate(tabs, placeOf('meetings', { meeting: `m${i}` }))
    expect(HISTORY).toBe(50)
    expect(activeTab(tabs).back).toHaveLength(50)
    expect(activeTab(tabs).back[0].meeting).toBe('m0')
    const here = activeTab(tabs).here
    tabs = back(tabs)
    expect(activeTab(tabs).here.meeting).toBe('m49')
    expect(activeTab(tabs).forward).toEqual([here])
    tabs = forward(tabs)
    expect(activeTab(tabs).here).toEqual(here)
    tabs = back(tabs)
    tabs = navigate(tabs, p(pages[0]))
    expect(activeTab(tabs).forward).toEqual([])
    const lone = at([p('jobs')])
    expect(back(lone)).toBe(lone)
  })

  it('closing the last tab leaves one Dashboard tab', () => {
    const tabs = closeTab(at([p('jobs')]), 0)
    expect(heres(tabs)).toEqual(['dashboard'])
    expect(tabs.list[0].id).not.toBe(0)
  })

  it('close rules with pins and index fixup', () => {
    let tabs = at([p('dashboard'), p('jobs'), p('habits')], 1)
    expect(closeActive(tabs)).toBe(tabs)
    tabs = closeOthers(tabs, tabs.list[2].id)
    expect(heres(tabs)).toEqual(['dashboard', 'habits'])
    expect(tabs.active).toBe(1)
    tabs = at([p('dashboard'), p('jobs'), p('habits')])
    tabs = activate(tabs, 2)
    tabs = closeTab(tabs, 0)
    expect(tabs.active).toBe(1)
    tabs = closeTab(tabs, tabs.list[1].id)
    expect(tabs.active).toBe(0)
  })

  it('openNewChat appends a draft chat tab at the end', () => {
    let tabs = openNewChat(at([p('jobs')]))
    tabs = openNewChat(tabs)
    expect(heres(tabs)).toEqual(['jobs', 'chat', 'chat'])
    expect(tabs.active).toBe(2)
    expect(activeTab(tabs).here.chat).toBe('draft')
  })

  it('round-trips a Rust-shaped fixture', () => {
    const place = (page: string, extra = {}) => ({
      page,
      chat: null,
      settings_section: 'Theme',
      meeting: null,
      canvas: null,
      ...extra,
    })
    const fixture = {
      active: 1,
      list: [
        {
          here: place('settings', { settings_section: 'Chat' }),
          back: [place('dashboard'), place('jobs')],
          forward: [],
          pinned: true,
        },
        { here: place('chat', { chat: 'draft' }), back: [], forward: [], pinned: false },
      ],
    }
    expect(saveTabs(loadTabs(fixture))).toEqual(fixture)
  })

  it('drops removed pages from tabs and history while preserving the active supported tab', () => {
    const tabs = loadTabs({
      active: 1,
      list: [
        { here: { page: 'inbox' } },
        {
          here: { page: 'jobs' },
          back: [{ page: 'dashboard' }, { page: 'tasks' }, { page: 'board:ops' }],
          forward: [{ page: 'help' }, { page: 'habits' }],
        },
        { here: { page: 'meetings' } },
      ],
    })
    expect(heres(tabs)).toEqual(['jobs', 'meetings'])
    expect(activeTab(tabs).here.page).toBe('jobs')
    expect(activeTab(tabs).back.map((place) => place.page)).toEqual(['dashboard'])
    expect(activeTab(tabs).forward.map((place) => place.page)).toEqual(['habits'])
    expect(heres(loadTabs({ list: [{ here: { page: 'board:ops' } }] }))).toEqual(['dashboard'])
  })

  it('load never throws and falls back to Dashboard', () => {
    for (const v of [
      null,
      5,
      'x',
      [],
      {},
      { list: 'no' },
      { list: [null, 1, { here: { page: 'zzz' } }] },
    ]) {
      expect(heres(loadTabs(v))).toEqual(['dashboard'])
    }
    const many = Array.from({ length: 80 }, () => ({ page: 'jobs' }))
    const t = loadTabs({ active: 99, list: [{ here: { page: 'habits' }, back: many }] })
    expect(t.list[0].back).toHaveLength(50)
    expect(t.active).toBe(0)
  })
})

describe('saveTabs bounds', () => {
  it('caps the list at 100 and clamps active', () => {
    let tabs = defaultTabs()
    for (let i = 0; i < 120; i++) tabs = openNewChat(tabs)
    const saved = saveTabs(tabs)
    expect(saved.list).toHaveLength(100)
    expect(saved.active).toBe(99)
  })
})
