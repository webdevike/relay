import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitBranch, recordWorktrees, WorkLedgers } from './work-line'

const dirs: string[] = []
const tmp = (): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-work-')))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('gitBranch (ported from look.rs)', () => {
  it('reads the branch of a repo and a worktree, none when detached', () => {
    const root = tmp()
    const repo = path.join(root, 'repo')
    fs.mkdirSync(path.join(repo, '.git/worktrees/wt'), { recursive: true })
    fs.mkdirSync(path.join(repo, 'src'))
    fs.writeFileSync(path.join(repo, '.git/HEAD'), 'ref: refs/heads/main\n')
    fs.writeFileSync(path.join(repo, '.git/worktrees/wt/HEAD'), 'ref: refs/heads/feat/ENG-1-x\n')
    const wt = path.join(root, 'wt')
    fs.mkdirSync(wt)
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ../repo/.git/worktrees/wt\n')
    expect(gitBranch(path.join(repo, 'src'))).toBe('main')
    expect(gitBranch(wt)).toBe('feat/ENG-1-x')
    fs.writeFileSync(path.join(repo, '.git/HEAD'), '0123abcd\n')
    expect(gitBranch(repo)).toBeNull()
  })
})

describe('recordWorktrees (ported from look.rs active_worktree)', () => {
  const EVA = '/Users/ike/Eva'
  const HOME = '/Users/ike'
  const call = (name: string, args: unknown) => ({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'toolCall', id: 't', name, arguments: args }] },
  })
  const checkouts = ['a', 'b', 'c'].map((n) => `${EVA}/work/${n}`)
  /** The worktree `records` last worked in, where only work/a, b and c are checkouts. */
  const active = (records: Array<Record<string, unknown>>): string | null => {
    let last: string | null = null
    for (const r of records) {
      for (const dir of recordWorktrees(r, EVA, HOME)) if (checkouts.includes(dir)) last = dir
    }
    return last
  }

  it('follows the one worktree a chat works in', () => {
    expect(
      active([
        call('read', { path: 'work/items/ENG-1.md' }),
        call('read', { path: 'work/a/src/x.rs:10-20' }),
        call('bash', { command: 'ls' }),
      ]),
    ).toBe(`${EVA}/work/a`)
    expect(active([call('bash', { command: 'ls' })])).toBeNull()
  })

  it('moving to another worktree moves the line', () => {
    const lines = [
      call('edit', { input: '[work/a/x.rs#1A2B]\nPUT 1.=1:\n+x' }),
      call('write', { path: '/Users/ike/Eva/work/b/y.ts', content: 'work/a' }),
      call('grep', { pattern: 'x', path: 'src;work/c/z' }),
    ]
    expect(active(lines.slice(0, 1))).toBe(`${EVA}/work/a`)
    expect(active(lines.slice(0, 2))).toBe(`${EVA}/work/b`)
    expect(active(lines)).toBe(`${EVA}/work/c`)
  })

  it('folders under work that are not checkouts are ignored', () => {
    expect(
      active([
        call('bash', { cwd: 'work/a', command: 'ls' }),
        call('read', { path: 'work/items/ENG-1.md' }),
        call('write', { path: 'work/evaos-exp/shot.png' }),
        call('bash', { command: 'cd work/elysia && ls' }),
        call('read', { path: 'apps/evaos/src/main.rs' }),
      ]),
    ).toBe(`${EVA}/work/a`)
  })

  it('shell cd and git -C count; subagent records do not', () => {
    expect(active([call('bash', { command: 'cd ~/Eva/work/a && git status; ls ../b' })])).toBe(
      `${EVA}/work/a`,
    )
    expect(active([call('bash', { command: 'git -C "work/b" log -1 | cat' })])).toBe(
      `${EVA}/work/b`,
    )
    // A `cd` moves where the next relative `cd` starts; the call's `cwd` is where it began.
    expect(
      active([call('bash', { cwd: 'work/a', command: 'cd ../c && cd src && ls $HOME' })]),
    ).toBe(`${EVA}/work/c`)
    expect(active([{ ...call('read', { path: 'work/a/x' }), isSidechain: true }])).toBeNull()
  })
})

describe('WorkLedgers', () => {
  it('reads ledgers, skips companions, and re-reads only a changed file', () => {
    const root = tmp()
    const items = path.join(root, 'work/items')
    fs.mkdirSync(path.join(items, 'ENG-7.assets'), { recursive: true })
    fs.writeFileSync(
      path.join(items, 'ENG-7.md'),
      '---\nkey: ENG-7\nbranch: feat/ENG-7-x\nworktree: work/wt-ENG-7\npr: https://github.com/a/b/pull/12\n---\n',
    )
    fs.writeFileSync(
      path.join(items, 'ENG-7.pr.md'),
      '---\npr: https://github.com/a/b/pull/99\n---\n',
    )
    fs.writeFileSync(path.join(items, 'notes.md'), '# nothing to join on\n')
    const ledgers = new WorkLedgers(root)
    expect(ledgers.current()).toEqual([
      {
        key: 'ENG-7',
        linear: 'ENG-7',
        pr: { repo: 'a/b', number: 12 },
        branch: 'feat/ENG-7-x',
        worktree: path.join(root, 'work/wt-ENG-7'),
        title: null,
      },
    ])
    fs.writeFileSync(
      path.join(items, 'ENG-7.md'),
      '---\nbranch: main\npr: https://github.com/a/b/pull/13\n---\n',
    )
    expect(ledgers.current().map((l) => [l.key, l.branch, l.pr?.number])).toEqual([
      ['ENG-7', null, 13],
    ])
    expect(new WorkLedgers(path.join(root, 'missing')).current()).toEqual([])
  })
})
