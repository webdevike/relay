import { describe, expect, it } from 'vitest'
import { placeOf } from '@evaos/shell-core'
import { setMeetingTitles, setWorkspaceNames } from '../eva/names-store'
import { pageMeta } from './page-meta'

describe('page-meta', () => {
  it('maps places to meta', () => {
    expect(pageMeta(placeOf('test-bench'))).toMatchObject({
      kind: 'page',
      slug: 'test-bench',
      title: 'Test Bench',
    })
    expect(pageMeta(placeOf('skills'))).toMatchObject({
      kind: 'page',
      slug: 'skills',
      title: 'Skills',
    })
    expect(pageMeta(placeOf('workspace:abc'))).toMatchObject({
      kind: 'workspace',
      slug: 'workspace',
      title: 'abc',
    })
    setWorkspaceNames({ flo: 'Flo' })
    expect(pageMeta(placeOf('workspace:flo')).title).toBe('Flo')
    expect(pageMeta(placeOf('meetings', { meeting: 'stem' }))).toMatchObject({
      kind: 'meeting',
      slug: 'meeting',
      title: 'stem',
    })
    setMeetingTitles({ stem: 'Daily standup' })
    expect(pageMeta(placeOf('meetings', { meeting: 'stem' })).title).toBe('Daily standup')
    expect(pageMeta(placeOf('meetings')).kind).toBe('page')
    expect(pageMeta(placeOf('settings', { settingsSection: 'Chat' })).kind).toBe('settings')
    expect(pageMeta(placeOf('canvas'))).toMatchObject({ kind: 'canvas', title: 'Canvas' })
    expect(pageMeta(placeOf('canvas', { canvas: 'ui-moodboard' })).kind).toBe('canvas')
    expect(pageMeta(placeOf('studio'))).toMatchObject({
      kind: 'page',
      slug: 'studio',
      title: 'Studio',
    })
  })
})
