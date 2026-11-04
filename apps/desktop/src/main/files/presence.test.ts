import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PresenceEdit, PresenceFocus } from '@evaos/contract'
import type { RelayFrames } from '../relay/client'
import { createFilesPresence, localHostPath } from './presence'

function fakeFrames(): RelayFrames & {
  sent: Record<string, unknown>[]
  push(f: Record<string, unknown>): void
} {
  const listeners = new Set<(f: Record<string, unknown>) => void>()
  const sent: Record<string, unknown>[] = []
  return {
    sent,
    onFrame: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    sendFrame: (f) => {
      sent.push(f)
      return true
    },
    push: (f) => {
      for (const cb of listeners) cb(f)
    },
  }
}

function setup(features: string[] = ['files.presence']) {
  const frames = fakeFrames()
  const edits: PresenceEdit[] = []
  const focus: PresenceFocus[][] = []
  const presence = createFilesPresence({
    frames,
    hostPathOf: localHostPath(false),
    origin: () => 'http://mini:8787',
    emitEdit: (e) => edits.push(e),
    emitFocus: (f) => focus.push(f),
  })
  frames.push({ t: 'welcome', state: {}, features })
  return { frames, edits, focus, presence }
}

describe('files presence (main)', () => {
  it('says nothing to a host without the feature', () => {
    const { frames, presence } = setup(['query'])
    presence.open([{ root: '/eva', path: 'a.md' }])
    presence.caret({ root: '/eva', path: 'a.md', caret: { line: 1, column: 1 } })
    presence.noteSave('/eva', 'a.md', 'x')
    expect(frames.sent).toEqual([])
  })

  it('sends open files as host paths, carets once each, and its saves by hash', () => {
    const { frames, presence } = setup()
    expect(frames.sent).toEqual([{ t: 'files.open', paths: [] }])
    presence.open([
      { root: '/eva', path: 'work/a.md' },
      { root: '/eva/work', path: 'a.md' },
    ])
    // The same file under two roots is one host path; an unchanged set is not resent.
    presence.open([
      { root: '/eva/work', path: 'a.md' },
      { root: '/eva', path: 'work/a.md' },
    ])
    const at = { root: '/eva', path: 'work/a.md', caret: { line: 4, column: 2 } }
    presence.caret(at)
    presence.caret(at)
    presence.noteSave('/eva', 'work/a.md', 'héllo')
    expect(frames.sent.slice(1)).toEqual([
      { t: 'files.open', paths: ['/eva/work/a.md'] },
      { t: 'files.caret', focus: { path: '/eva/work/a.md', caret: { line: 4, column: 2 } } },
      {
        t: 'files.saved',
        path: '/eva/work/a.md',
        hash: createHash('sha1').update(Buffer.from('héllo', 'utf8')).digest('hex'),
      },
    ])
  })

  it('says it all again on a new connection', () => {
    const { frames, presence } = setup()
    presence.open([{ root: '/eva', path: 'a.md' }])
    presence.caret({ root: '/eva', path: 'a.md', caret: { line: 2, column: 1 } })
    frames.sent.length = 0
    frames.push({ t: 'welcome', state: {}, features: ['files.presence'] })
    expect(frames.sent).toEqual([
      { t: 'files.open', paths: ['/eva/a.md'] },
      { t: 'files.caret', focus: { path: '/eva/a.md', caret: { line: 2, column: 1 } } },
    ])
  })

  it('hands an edit to every tab showing that file, with the portrait as a host URL', () => {
    const { frames, edits, presence } = setup()
    presence.open([
      { root: '/eva', path: 'work/a.md' },
      { root: '/eva/work', path: 'a.md' },
    ])
    const edit = {
      t: 'files.edit',
      path: '/eva/work/a.md',
      hash: 'h1',
      ranges: [{ startLine: 3, endLine: 4 }],
      caret: { line: 4, column: 9 },
      agent: { name: 'Nova', color: '#12b886', avatar: '/canvas/avatar/nova', sessionId: 's1' },
      intent: 'Fixing notes',
      at: 5,
    }
    frames.push(edit)
    frames.push({ ...edit, path: '/eva/other.md' })
    expect(edits).toEqual([
      {
        targets: [
          { root: '/eva', path: 'work/a.md' },
          { root: '/eva/work', path: 'a.md' },
        ],
        hash: 'h1',
        ranges: [{ startLine: 3, endLine: 4 }],
        caret: { line: 4, column: 9 },
        agent: { name: 'Nova', color: '#12b886', avatarUrl: 'http://mini:8787/canvas/avatar/nova' },
        intent: 'Fixing notes',
        at: 5,
      },
    ])
  })

  it('maps nothing on a thin client: its own disk is not the host', () => {
    expect(localHostPath(true)('/Users/ike/Eva', 'a.md')).toBeNull()
    expect(localHostPath(false)('/Users/ike/Eva', 'a.md')).toBe('/Users/ike/Eva/a.md')
  })
})
