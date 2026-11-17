import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { publishSave, readInstallSource, type PublishDeps } from './publish'

const SPEC = 'packages/atomic-agents/domains/design/design-critic.rules.md'
const AUTHOR = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 't@example.com',
}

let dir: string
let origin: string
let clone: string
let home: string

const sh = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: { ...process.env, ...AUTHOR }, encoding: 'utf8' }).trim()

const realGit: PublishDeps['git'] = async (gitDir, args, env, input) => {
  const r = spawnSync('git', args, {
    env: { ...process.env, ...AUTHOR, ...env, GIT_DIR: gitDir },
    input: input ?? '',
    encoding: 'utf8',
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}
const deps = (ok = true): PublishDeps => ({
  git: realGit,
  validate: async () => (ok ? { ok: true } : { ok: false, message: 'knowledge: x.md is missing' }),
})

/** Main's file as it is on origin now. */
const onMain = (): string => sh(clone, 'show', `origin/main:${SPEC}`)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-publish-'))
  origin = path.join(dir, 'origin.git')
  clone = path.join(dir, 'clone')
  home = path.join(dir, 'home')
  sh(dir, 'init', '--bare', '-b', 'main', origin)
  sh(dir, 'clone', '--quiet', origin, clone)
  fs.mkdirSync(path.join(clone, path.dirname(SPEC)), { recursive: true })
  fs.writeFileSync(path.join(clone, SPEC), 'rule one\n')
  // Someone's unrelated, uncommitted work in the clone stays untouched.
  fs.writeFileSync(path.join(clone, 'wip.txt'), 'mine\n')
  sh(clone, 'add', SPEC)
  sh(clone, 'commit', '--quiet', '-m', 'init')
  sh(clone, 'push', '--quiet', 'origin', 'HEAD:main')
  fs.mkdirSync(path.join(home, 'app/atomic-agents/domains/design'), { recursive: true })
  fs.writeFileSync(
    path.join(home, 'app/source.json'),
    JSON.stringify({ gitDir: path.join(clone, '.git'), package: 'packages/atomic-agents' }),
  )
})

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const save = (before: string | null, after: string) => ({
  agent: 'design-critic',
  agentFile: path.join(home, 'app/atomic-agents/domains/design/design-critic.json'),
  file: path.join(home, 'app/atomic-agents/domains/design/design-critic.rules.md'),
  rel: 'design-critic.rules.md',
  before,
  after,
})

describe('publishSave', () => {
  it("commits the installed copy's edit onto origin's main without touching the checkout", async () => {
    const head = sh(clone, 'rev-parse', 'HEAD')
    const out = await publishSave(
      deps(),
      home,
      readInstallSource(home),
      save('rule one\n', 'rule two\n'),
    )
    expect(out.state).toBe('committed')
    sh(clone, 'fetch', '--quiet')
    expect(onMain()).toBe('rule two')
    expect(sh(clone, 'log', '-1', '--format=%s', 'origin/main')).toBe(
      'design-critic: edit design-critic.rules.md (from the Relay Agents page)',
    )
    expect(sh(clone, 'rev-parse', 'origin/main')).toBe(out.sha)
    // The checkout, its index and the other work in it are as they were.
    expect(sh(clone, 'rev-parse', 'HEAD')).toBe(head)
    expect(fs.readFileSync(path.join(clone, SPEC), 'utf8')).toBe('rule one\n')
    expect(sh(clone, 'status', '--porcelain')).toBe('?? wip.txt')
    // A second save builds on the first.
    const next = await publishSave(
      deps(),
      home,
      readInstallSource(home),
      save('rule two\n', 'rule three\n'),
    )
    expect(next.state).toBe('committed')
    sh(clone, 'fetch', '--quiet')
    expect(onMain()).toBe('rule three')
  })

  it('leaves main alone when main changed the file since the install, or already has the text', async () => {
    const diverged = await publishSave(
      deps(),
      home,
      readInstallSource(home),
      save('an older install\n', 'rule two\n'),
    )
    expect(diverged.state).toBe('kept')
    expect(diverged.detail).toMatch(/main changed this file/)
    const same = await publishSave(
      deps(),
      home,
      readInstallSource(home),
      save('anything\n', 'rule one\n'),
    )
    expect(same.state).toBe('unchanged')
    sh(clone, 'fetch', '--quiet')
    expect(onMain()).toBe('rule one')
  })

  it('does not commit an edit the agent does not load with, or without a recorded repo', async () => {
    const invalid = await publishSave(
      deps(false),
      home,
      readInstallSource(home),
      save('rule one\n', 'rule two\n'),
    )
    expect(invalid).toMatchObject({ state: 'invalid', sha: null })
    expect(invalid.detail).toMatch(/knowledge: x.md is missing/)
    const unknown = await publishSave(deps(), home, null, save('rule one\n', 'rule two\n'))
    expect(unknown.state).toBe('kept')
    sh(clone, 'fetch', '--quiet')
    expect(onMain()).toBe('rule one')
  })
})
