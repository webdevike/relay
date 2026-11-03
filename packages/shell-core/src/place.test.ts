import { describe, expect, it } from 'vitest'
import {
  pageFromKey,
  pageKey,
  placeFromJson,
  placeKey,
  placeOf,
  placeToJson,
  samePlace,
  type PageKey,
} from './place'

describe('pages', () => {
  it('pages round trip through their keys', () => {
    const pages: PageKey[] = [
      'dashboard',
      'workspace:alpha',
      'chat',
      'jobs',
      'test-bench',
      'habits',
      'meetings',
      'canvas',
      'rooms',
      'studio',
      'settings',
      'board:ops',
    ]
    for (const p of pages) expect(pageFromKey(pageKey(p))).toBe(p)
    expect(pageFromKey('nope')).toBeNull()
    expect(pageFromKey('board:')).toBeNull()
    expect(pageFromKey('review:')).toBeNull()
    for (const key of [
      'review:pr:eCardSystems/api#172',
      'review:linear:ENG-6648',
      'review:slack:C1:',
    ]) {
      expect(pageFromKey(key)).toBe(key)
      expect(placeFromJson(placeToJson(placeOf(key as PageKey)))).toEqual(placeOf(key as PageKey))
      expect(placeKey(placeOf(key as PageKey))).toBe(key)
    }
    expect(samePlace(placeOf('review:pr:a/b#1'), placeOf('review:pr:a/b#2'))).toBe(false)
    expect(samePlace(placeOf('review:pr:a/b#1'), placeOf('review:pr:a/b#1'))).toBe(true)
  })

  it('rejects removed destinations when restoring navigation', () => {
    for (const page of ['inbox', 'calendar', 'tasks', 'memory', 'files', 'help']) {
      expect(pageFromKey(page)).toBeNull()
      expect(placeFromJson({ page })).toBeNull()
    }
    expect(
      placeFromJson({ page: 'settings', settings_section: 'Notifications' })?.settingsSection,
    ).toBe('Theme')
  })
})

describe('saved places', () => {
  it('saved places tolerate missing fields', () => {
    expect(placeFromJson(placeToJson(placeOf('test-bench')))).toEqual(placeOf('test-bench'))
    expect(placeFromJson({ page: 'settings' })).toEqual({
      page: 'settings',
      chat: null,
      settingsSection: 'Theme',
      meeting: null,
      canvas: null,
    })
    expect(placeFromJson({ page: 'chat' })?.chat).toBe('draft')
    expect(placeFromJson({ page: 'chat', chat: '/s/a.jsonl' })?.chat).toBe('/s/a.jsonl')
    expect(placeFromJson({ page: 'settings', settings_section: 'Chat' })?.settingsSection).toBe(
      'Chat',
    )
    expect(placeFromJson({ page: 'settings', settings_section: 'Bogus' })?.settingsSection).toBe(
      'Theme',
    )
    expect(placeFromJson({ page: 'nope' })).toBeNull()
    expect(placeFromJson({})).toBeNull()
    expect(placeFromJson(null)).toBeNull()
    expect(placeFromJson(42)).toBeNull()
  })

  it('serialises with Rust key names', () => {
    expect(placeToJson(placeOf('chat', { chat: '/s/a.jsonl' }))).toEqual({
      page: 'chat',
      chat: '/s/a.jsonl',
      settings_section: 'Theme',
      meeting: null,
      canvas: null,
    })
    expect(placeToJson(placeOf('jobs')).chat).toBeNull()
    expect(placeToJson(placeOf('canvas', { canvas: 'ui-moodboard' })).canvas).toBe('ui-moodboard')
    expect(placeFromJson({ page: 'canvas', canvas: 'ecs-roles' })?.canvas).toBe('ecs-roles')
    expect(placeFromJson({ page: 'jobs', canvas: 'ecs-roles' })?.canvas).toBeNull()
  })
})

describe('place matching', () => {
  it('places match by what they show', () => {
    expect(samePlace(placeOf('jobs'), placeOf('jobs'))).toBe(true)
    expect(samePlace(placeOf('jobs'), placeOf('habits'))).toBe(false)
    expect(samePlace(placeOf('chat'), placeOf('chat'))).toBe(false)
    const a = placeOf('chat', { chat: '/s/a.jsonl' })
    expect(samePlace(a, placeOf('chat', { chat: '/s/a.jsonl' }))).toBe(true)
    expect(samePlace(a, placeOf('chat', { chat: '/s/b.jsonl' }))).toBe(false)
    const s = (settingsSection: 'Theme' | 'Chat') => placeOf('settings', { settingsSection })
    expect(samePlace(s('Chat'), s('Chat'))).toBe(true)
    expect(samePlace(s('Chat'), s('Theme'))).toBe(false)
    const m = (meeting: string | null) => placeOf('meetings', { meeting })
    expect(samePlace(m(null), m(null))).toBe(true)
    expect(samePlace(m('a'), m('b'))).toBe(false)
    const c = (canvas: string | null) => placeOf('canvas', { canvas })
    expect(samePlace(c('a'), c('a'))).toBe(true)
    expect(samePlace(c('a'), c('b'))).toBe(false)
  })

  it('placeKey formats', () => {
    expect(placeKey(placeOf('dashboard'))).toBe('page:dashboard')
    expect(placeKey(placeOf('settings', { settingsSection: 'Chat' }))).toBe('settings:Chat')
    expect(placeKey(placeOf('chat'))).toBe('chat:draft')
    expect(placeKey(placeOf('chat', { chat: '/s/a.jsonl' }))).toBe('chat:/s/a.jsonl')
    expect(placeKey(placeOf('workspace:alpha'))).toBe('workspace:alpha')
    expect(placeKey(placeOf('meetings', { meeting: 'stem' }))).toBe('meeting:stem')
    expect(placeKey(placeOf('canvas'))).toBe('page:canvas')
    expect(placeKey(placeOf('canvas', { canvas: 'ui-moodboard' }))).toBe('canvas:ui-moodboard')
  })
})
