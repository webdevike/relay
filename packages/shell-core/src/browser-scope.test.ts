import { describe, expect, it } from 'vitest'
import { PINNED_SCOPE, browserScope } from './browser-scope'
import { placeOf } from './place'

describe('browserScope', () => {
  it('a chat with a session file is scoped to the file', () => {
    expect(browserScope(placeOf('chat', { chat: '/s/a.jsonl' }), 4)).toBe('chat:/s/a.jsonl')
  })

  it('a draft chat is scoped to its app tab', () => {
    expect(browserScope(placeOf('chat'), 4)).toBe('draft:4')
    expect(browserScope(placeOf('chat', { chat: null }), 7)).toBe('draft:7')
  })

  it('two app tabs on the same chat file share one scope', () => {
    const place = placeOf('chat', { chat: '/s/a.jsonl' })
    expect(browserScope(place, 1)).toBe(browserScope(place, 2))
  })

  it('pages are scoped by page key plus their own id', () => {
    expect(browserScope(placeOf('dashboard'), 1)).toBe('page:dashboard')
    expect(browserScope(placeOf('canvas'), 1)).toBe('page:canvas')
    expect(browserScope(placeOf('canvas', { canvas: 'ui-moodboard' }), 1)).toBe(
      'page:canvas:ui-moodboard',
    )
    expect(browserScope(placeOf('meetings'), 1)).toBe('page:meetings')
    expect(browserScope(placeOf('meetings', { meeting: '2026-10-01-standup' }), 1)).toBe(
      'page:meetings:2026-10-01-standup',
    )
    expect(browserScope(placeOf('workspace:relay'), 1)).toBe('page:workspace:relay')
    expect(browserScope(placeOf('settings', { settingsSection: 'Chat' }), 1)).toBe('page:settings')
  })

  it('no place scope collides with the pinned scope', () => {
    expect(browserScope(placeOf('dashboard'), 0)).not.toBe(PINNED_SCOPE)
  })
})
