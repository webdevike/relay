import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SearchResult } from '@evaos/contract'
import { createSearch, MAX_PER_FILE, type FilesSearch, type SearchQuery } from './files-search'

let base: string
let env: NodeJS.ProcessEnv

const put = (dir: string, rel: string, data: string): void => {
  const abs = path.join(dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, data)
}

/** Files and lines the queries below run over. */
function fill(dir: string): void {
  put(dir, 'a.txt', 'héllo Foo foo\nfoobar\n')
  put(dir, 'b.md', 'Foo\n')
  put(dir, 'bin.dat', 'foo\0foo')
  put(dir, 'secrets/k', 'foo\n')
}

const q = (query: string, o: Partial<SearchQuery> = {}): SearchQuery => ({
  query,
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  ...o,
})

/** path -> [line, column, length] per match. */
const hits = (r: SearchResult): Record<string, number[][]> =>
  Object.fromEntries(
    r.results.map((f) => [f.path, f.matches.map((m) => [m.line, m.column, m.length])]),
  )

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-files-')))
  env = { ...process.env, GIT_CEILING_DIRECTORIES: base }
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

const engines: Array<['git' | 'scan', (dir: string) => void]> = [
  [
    'git',
    (dir) => {
      execFileSync('git', ['init', '-q'], { cwd: dir, env, stdio: 'pipe' })
      fill(dir)
    },
  ],
  ['scan', (dir) => fill(dir)],
]

describe.each(engines)('%s engine', (engine, setup) => {
  let root: string
  let search: FilesSearch['search']

  beforeEach(() => {
    root = path.join(base, 'root')
    fs.mkdirSync(root)
    setup(root)
    search = createSearch(
      () => Promise.resolve(env),
      () => Promise.resolve(null),
    ).search
  })

  it('finds every match with 1-based UTF-16 columns, case-insensitively', async () => {
    const r = await search(root, q('foo'))
    expect(r.engine).toBe(engine)
    expect(r.truncated).toBe(false)
    expect(hits(r)).toEqual({
      'a.txt': [
        [1, 7, 3],
        [1, 11, 3],
        [2, 1, 3],
      ],
      'b.md': [[1, 1, 3]],
    })
    const m = r.results.find((f) => f.path === 'a.txt')!.matches[1]!
    expect(m.preview.slice(m.previewStart, m.previewStart + m.length)).toBe('foo')
  })

  it('honors case sensitivity, whole words and regex', async () => {
    expect(hits(await search(root, q('foo', { caseSensitive: true })))).toEqual({
      'a.txt': [
        [1, 11, 3],
        [2, 1, 3],
      ],
    })
    expect(hits(await search(root, q('foo', { wholeWord: true })))).toEqual({
      'a.txt': [
        [1, 7, 3],
        [1, 11, 3],
      ],
      'b.md': [[1, 1, 3]],
    })
    expect(hits(await search(root, q('fo+b', { regex: true })))).toEqual({ 'a.txt': [[2, 1, 4]] })
    // A fixed string is not a pattern.
    expect(hits(await search(root, q('fo+b')))).toEqual({})
  })

  it('caps matches per file', async () => {
    put(root, 'many.txt', 'zz\n'.repeat(MAX_PER_FILE + 50))
    const r = await search(root, q('zz'))
    expect(r.truncated).toBe(true)
    expect(r.results.find((f) => f.path === 'many.txt')!.matches).toHaveLength(MAX_PER_FILE)
  })
})

describe('scan engine', () => {
  it('rejects a broken pattern', async () => {
    fs.mkdirSync(path.join(base, 'root'))
    const { search } = createSearch(
      () => Promise.resolve(env),
      () => Promise.resolve(null),
    )
    await expect(search(path.join(base, 'root'), q('(', { regex: true }))).rejects.toMatchObject({
      code: 'invalid-query',
    })
  })

  it('lets a newer search on the same root cancel the running one', async () => {
    const root = path.join(base, 'root')
    for (let i = 0; i < 200; i++) put(root, `d${i}/f.txt`, 'needle\n')
    const { search } = createSearch(
      () => Promise.resolve(env),
      () => Promise.resolve(null),
    )
    const first = search(root, q('needle'))
    const second = search(root, q('needle'))
    await expect(first).rejects.toMatchObject({ code: 'cancelled' })
    expect((await second).results).toHaveLength(200)
  })
})
