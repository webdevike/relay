import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listSessionFiles, ompAgentDirsFrom, ompSessionsDirIn, sessionsDirs } from './sessions-dir'

const dirs: string[] = []
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'chatcore-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const write = (file: string, lines: unknown[], mtime: number): void => {
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  fs.utimesSync(file, mtime, mtime)
}

describe('listSessionFiles', () => {
  it('lists .jsonl newest first with the title from line 1', () => {
    const d = tmp()
    write(path.join(d, 'a.jsonl'), [{ type: 'title', title: 'Old' }], 1000)
    write(path.join(d, 'b.jsonl'), [{ type: 'title', title: 'New' }], 2000)
    fs.writeFileSync(path.join(d, 'c.txt'), 'x')
    expect(listSessionFiles(d).map((s) => s.title)).toEqual(['New', 'Old'])
  })

  it('falls back to the first prompt when the title is empty and caps the list', () => {
    const d = tmp()
    write(
      path.join(d, 'a.jsonl'),
      [
        { type: 'title', title: '' },
        {
          type: 'message',
          id: '1',
          parentId: null,
          message: { role: 'user', content: 'hello there', attribution: 'user' },
        },
      ],
      1000,
    )
    expect(listSessionFiles(d)[0]!.title).toBe('hello there')
    for (let i = 0; i < 5; i++)
      write(path.join(d, `f${i}.jsonl`), [{ type: 'title', title: `T${i}` }], 2000 + i)
    expect(listSessionFiles(d, 3)).toHaveLength(3)
  })

  it('returns an empty list for a missing directory', () => {
    expect(listSessionFiles('/nonexistent/evaos-dir')).toEqual([])
  })
})

describe('ompSessionsDirIn', () => {
  it('picks the sessions dir whose newest file records the Eva root as cwd', () => {
    const agent = tmp()
    const root = tmp()
    const other = path.join(agent, 'sessions', '-Other')
    const mine = path.join(agent, 'sessions', '-Eva')
    fs.mkdirSync(other, { recursive: true })
    fs.mkdirSync(mine, { recursive: true })
    write(
      path.join(other, 'x.jsonl'),
      [
        { type: 'title', title: '' },
        { type: 'session', cwd: '/elsewhere' },
      ],
      1000,
    )
    write(
      path.join(mine, 'y.jsonl'),
      [
        { type: 'title', title: '' },
        { type: 'session', cwd: root },
      ],
      1000,
    )
    expect(ompSessionsDirIn(agent, root)).toBe(mine)
    expect(ompSessionsDirIn(agent, '/nope')).toBeNull()
  })
})

describe('sessionsDirs', () => {
  const store = (agent: string, slug: string, cwd: string): string => {
    const dir = path.join(agent, 'sessions', slug)
    fs.mkdirSync(dir, { recursive: true })
    write(path.join(dir, 's.jsonl'), [{ type: 'session', cwd }], 1000)
    return dir
  }

  it('spans the default store, the Current one and every profile, default first', () => {
    const home = tmp()
    const root = tmp()
    const current = path.join(home, 'agent')
    const personal = path.join(home, 'profiles', 'personal', 'agent')
    const work = path.join(home, 'profiles', 'work', 'agent')
    const a = store(current, '-Eva', root)
    const b = store(personal, '-Eva', root)
    const c = store(work, '-Eva', root)
    store(work, '-Elsewhere', '/elsewhere')
    fs.mkdirSync(path.join(home, 'profiles', 'empty'), { recursive: true })
    // Started from a profile shell: that store first, then Current, then the other profiles.
    expect(ompAgentDirsFrom(personal)).toEqual([personal, current, work])
    expect(sessionsDirs(root, personal)).toEqual([b, a, c])
    // Started from the Current store: every profile after it.
    expect(ompAgentDirsFrom(current)).toEqual([current, personal, work])
    expect(sessionsDirs(root, current)).toEqual([a, b, c])
  })
})
