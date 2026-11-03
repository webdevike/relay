import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assistantSessions, LineCache } from './sessions'

describe('assistantSessions', () => {
  it('lists every open session it started and only the newest closed ones', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-'))
    const dir = path.join(root, 'work/eva/agents/astra')
    fs.mkdirSync(dir, { recursive: true })
    const file = (name: string): string => {
      const f = path.join(root, `${name}.jsonl`)
      fs.writeFileSync(f, '')
      return f
    }
    const entries = [
      { sessionFile: file('old-open'), title: 'ENG-1 auto-work' },
      { sessionFile: file('c1'), title: 'ENG-2 auto-work', closedAt: '2026-10-29T00:00:00Z' },
      { sessionFile: file('c2'), title: 'ENG-3 auto-work', closedAt: '2026-10-29T00:00:00Z' },
      { sessionFile: file('new-open'), title: 'ENG-4 auto-work' },
    ]
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(entries))
    const out = assistantSessions(root, 'astra', Date.now() + 3_600_000, new LineCache(), 1)
    expect(out.map((w) => [w.name, w.closed])).toEqual([
      ['ENG-4 auto-work', false],
      ['ENG-3 auto-work', true],
      ['ENG-1 auto-work', false],
    ])
  })
})
