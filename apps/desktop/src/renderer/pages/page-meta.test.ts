import { describe, expect, it } from 'vitest'
import { placeOf } from '@evaos/shell-core'
import { setWorkspaceNames } from '../eva/names-store'
import { NAV_PAGES, pageMeta } from './page-meta'

describe('page-meta', () => {
  it('lists nav pages in order with UI-SPEC copy and no em dashes', () => {
    expect(NAV_PAGES.map((n) => n.slug)).toEqual([
      'dashboard',
      'inbox',
      'chat',
      'jobs',
      'habits',
      'meetings',
      'calendar',
      'tasks',
      'memory',
      'files',
      'setting',
      'help',
    ])
    const get = (s: string) => NAV_PAGES.find((n) => n.slug === s)!
    expect(get('dashboard').description).toBe(
      'Your workspaces, activity and open todos will appear here in a later update.',
    )
    expect(get('memory').description).toBe("Eva's memory will appear here in a later update.")
    expect(get('files').description).toBe('Browse and edit files from here in a later update.')
    expect(get('help').title).toBe('Help Center')
    expect(get('setting').title).toBe('Setting')
    for (const n of NAV_PAGES) {
      expect(JSON.stringify(n)).not.toContain(String.fromCharCode(0x2014))
    }
  })

  it('maps places to meta', () => {
    expect(pageMeta(placeOf('inbox'))).toMatchObject({
      kind: 'page',
      slug: 'inbox',
      title: 'Inbox',
    })
    expect(pageMeta(placeOf('workspace:abc'))).toMatchObject({
      kind: 'workspace',
      slug: 'workspace',
      title: 'abc',
    })
    setWorkspaceNames({ flo: 'Flo' })
    expect(pageMeta(placeOf('workspace:flo')).title).toBe('Flo')
    expect(pageMeta(placeOf('board:b1'))).toMatchObject({
      kind: 'board',
      slug: 'board',
      title: 'b1',
    })
    expect(pageMeta(placeOf('meetings', { meeting: 'stem' }))).toMatchObject({
      kind: 'meeting',
      slug: 'meeting',
      title: 'stem',
    })
    expect(pageMeta(placeOf('meetings')).kind).toBe('page')
    expect(pageMeta(placeOf('settings', { settingsSection: 'Chat' })).kind).toBe('settings')
  })
})
