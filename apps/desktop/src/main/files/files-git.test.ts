import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitStatusCache, gitStatus, parsePorcelain } from './files-git'
import { allFiles } from './files-search'

let base: string
let repo: string
// A ceiling at the tmp folder: a plain folder there is never inside some outer checkout.
let env: NodeJS.ProcessEnv

const put = (rel: string, data: string, dir = repo): void => {
  const abs = path.join(dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, data)
}
const git = (...args: string[]): void => {
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo, env, stdio: 'pipe' })
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-files-')))
  env = { ...process.env, GIT_CEILING_DIRECTORIES: base }
  repo = path.join(base, 'repo')
  fs.mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'files@test')
  git('config', 'user.name', 'Files Test')
  put('tracked.txt', 'one\n')
  put('gone.txt', 'bye\n')
  put('sub/s.txt', 'sub\n')
  put('.gitignore', 'build/\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  put('tracked.txt', 'two\n')
  fs.rmSync(path.join(repo, 'gone.txt'))
  put('new.txt', 'new\n')
  put('newdir/x.txt', 'x\n')
  put('build/out.js', 'built\n')
  put('staged.txt', 'staged\n')
  put('secrets/k', 'k\n')
  git('add', 'staged.txt')
  put('sub/s.txt', 'changed\n')
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe('gitStatus', () => {
  it('maps porcelain codes and ignored folders', async () => {
    const st = await gitStatus(repo, env)
    expect(st.repo).toBe(true)
    expect(st.branch).toBe('main')
    expect(st.changes).toEqual({
      'tracked.txt': 'M',
      'gone.txt': 'D',
      'new.txt': 'U',
      newdir: 'U',
      secrets: 'U',
      'staged.txt': 'A',
      'sub/s.txt': 'M',
    })
    expect(st.ignored).toEqual(['build/'])
  })

  it('strips the prefix when the root is a folder inside the checkout', async () => {
    const st = await gitStatus(path.join(repo, 'sub'), env)
    expect(st).toEqual({ repo: true, branch: 'main', changes: { 's.txt': 'M' }, ignored: [] })
  })

  it('says repo:false outside a checkout', async () => {
    const plain = path.join(base, 'plain')
    fs.mkdirSync(plain)
    expect(await gitStatus(plain, env)).toEqual({
      repo: false,
      branch: null,
      changes: {},
      ignored: [],
    })
  })

  it('serves one run to concurrent callers and caches it briefly', async () => {
    let t = 0
    const status = createGitStatusCache(
      () => Promise.resolve(env),
      1500,
      () => t,
    )
    const a = status(repo)
    expect(status(repo)).toBe(a)
    await a
    t = 1000
    expect(status(repo)).toBe(a)
    t = 2000
    expect(status(repo)).not.toBe(a)
  })
})

describe('parsePorcelain', () => {
  it('reads renames (two fields), conflicts and drops paths outside the root', () => {
    const out = ['R  sub/new.txt', 'sub/old.txt', 'UU sub/c.txt', 'AA sub/both', ' M top.txt', '']
    expect(parsePorcelain(out.join('\0'), 'sub/')).toEqual({
      changes: { 'new.txt': 'R', 'c.txt': 'C', both: 'C' },
      ignored: [],
    })
  })
})

describe('allFiles', () => {
  it('lists tracked and untracked files, minus ignored and secrets', async () => {
    const { files, truncated } = await allFiles(repo, env)
    expect(truncated).toBe(false)
    expect([...files].sort()).toEqual([
      '.gitignore',
      'gone.txt',
      'new.txt',
      'newdir/x.txt',
      'staged.txt',
      'sub/s.txt',
      'tracked.txt',
    ])
  })

  it('walks a plain folder without .git, node_modules or secrets', async () => {
    const plain = path.join(base, 'plain')
    put('a.txt', 'a', plain)
    put('d/b.txt', 'b', plain)
    put('node_modules/m/index.js', 'm', plain)
    put('secrets/k', 'k', plain)
    put('.git', 'gitdir: elsewhere', plain)
    const { files } = await allFiles(plain, env)
    expect([...files].sort()).toEqual(['a.txt', 'd/b.txt'])
  })
})
