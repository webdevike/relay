// A save in an agent's folder lands in the service's installed copy (live within a second: the
// service re-reads its agent files every second, and knowledge on every run). This commits the same
// text back to the repo the service was installed from (`<home>/app/source.json`, written by
// `atomic-agents service install`), straight onto origin's main with git plumbing: no checkout is
// touched, so a busy clone with other work in it is safe. The commit is skipped when the agent does
// not load with the edit, or when main changed the file since the copy was installed (committing
// would undo that change); the save stays live either way and the editor says what happened.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { z } from 'zod'
import type { SpecialistSaved } from '@evaos/contract'

export interface GitResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface PublishDeps {
  /** Runs git with GIT_DIR set to the repo's git dir (stdin from `input`); never rejects. */
  git(
    gitDir: string,
    args: string[],
    env?: Record<string, string>,
    input?: string,
  ): Promise<GitResult>
  /** Whether the agent loads with the file as it is now (`atomic-agents agent validate <file>`). */
  validate(agentFile: string): Promise<{ ok: true } | { ok: false; message: string }>
}

export const SourceJson = z.object({
  /** The repo's git dir (a checkout's `.git`, its common dir). */
  gitDir: z.string().min(1),
  /** The package's folder in the repo, `packages/atomic-agents`. */
  package: z.string().min(1),
})
export type InstallSource = z.infer<typeof SourceJson>

/** The repo the installed copy came from, or null when the install did not record one. */
export function readInstallSource(home: string): InstallSource | null {
  try {
    return SourceJson.parse(
      JSON.parse(fs.readFileSync(path.join(home, 'app', 'source.json'), 'utf8')),
    )
  } catch {
    return null
  }
}

export interface SavedFile {
  agent: string
  /** The agent's file (AGENT.md or its spec), checked after the save. */
  agentFile: string
  /** The saved file (absolute, in the installed copy). */
  file: string
  /** Root-relative, as the editor names it. */
  rel: string
  before: string | null
  after: string
}

const PUSH_TRIES = 3
const lastWords = (r: GitResult): string =>
  (r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ').slice(0, 400) ||
  `git exited ${String(r.code)}`

/** Commits `saved` to the repo's main (see the file comment); what became of it, for the editor. */
export async function publishSave(
  deps: PublishDeps,
  home: string,
  source: InstallSource | null,
  saved: SavedFile,
  now: () => number = Date.now,
): Promise<SpecialistSaved> {
  const out = (
    state: SpecialistSaved['state'],
    detail: string,
    sha: string | null = null,
  ): SpecialistSaved => ({ agent: saved.agent, path: saved.rel, state, sha, detail, at: now() })

  const checked = await deps.validate(saved.agentFile)
  if (!checked.ok)
    return out(
      'invalid',
      `Saved, but ${saved.agent} does not load with it, so the service keeps the version before: ${checked.message}`,
    )
  const app = path.join(home, 'app', 'atomic-agents')
  const rel = path.relative(app, saved.file)
  if (rel.startsWith('..') || path.isAbsolute(rel))
    return out('kept', 'Live. This agent lives in your own agents folder, outside the repo.')
  if (source === null)
    return out(
      'kept',
      'Live, not committed: the installed service does not record its repo. Reinstall it with atomic-agents service install.',
    )
  const repoPath = path.posix.join(source.package, rel.split(path.sep).join('/'))
  const git = (args: string[], env?: Record<string, string>, input?: string) =>
    deps.git(source.gitDir, args, env, input)

  for (let attempt = 1; attempt <= PUSH_TRIES; attempt++) {
    const fetched = await git(['fetch', '--quiet', 'origin', 'main'])
    if (fetched.code !== 0)
      return out('failed', `Live, but git fetch failed: ${lastWords(fetched)}`)
    const parent = (await git(['rev-parse', 'refs/remotes/origin/main'])).stdout.trim()
    const listed = await git(['ls-tree', parent, '--', repoPath])
    const mode = /^(\d{6}) blob /.exec(listed.stdout)?.[1]
    if (listed.code !== 0 || mode === undefined)
      return out('kept', `Live, not committed: main has no ${repoPath}.`)
    const theirs = await git(['cat-file', 'blob', `${parent}:${repoPath}`])
    if (theirs.stdout === saved.after)
      return out('unchanged', 'Live. Main already has this version.', parent.slice(0, 12))
    if (saved.before === null || theirs.stdout !== saved.before)
      return out(
        'kept',
        'Live, not committed: main changed this file since the service was installed. Reinstall the service from main, then make the edit again.',
      )
    const blob = (await git(['hash-object', '-w', '--stdin'], undefined, saved.after)).stdout.trim()
    const index = path.join(os.tmpdir(), `relay-agent-index-${process.pid}-${String(now())}`)
    try {
      const env = { GIT_INDEX_FILE: index }
      const steps: string[][] = [
        ['read-tree', parent],
        ['update-index', '--cacheinfo', `${mode},${blob},${repoPath}`],
      ]
      for (const step of steps) {
        const r = await git(step, env)
        if (r.code !== 0) return out('failed', `Live, but git ${step[0]} failed: ${lastWords(r)}`)
      }
      const tree = await git(['write-tree'], env)
      if (tree.code !== 0)
        return out('failed', `Live, but git write-tree failed: ${lastWords(tree)}`)
      const message = `${saved.agent}: edit ${saved.rel} (from the Relay Agents page)`
      const commit = await git(['commit-tree', tree.stdout.trim(), '-p', parent, '-m', message])
      if (commit.code !== 0)
        return out('failed', `Live, but git commit failed: ${lastWords(commit)}`)
      const sha = commit.stdout.trim()
      const pushed = await git(['push', '--quiet', 'origin', `${sha}:refs/heads/main`])
      if (pushed.code === 0) {
        // The clone's view of main follows, so the next save starts from this commit.
        await git(['update-ref', 'refs/remotes/origin/main', sha, parent])
        return out('committed', `Live, and committed to main as ${sha.slice(0, 7)}.`, sha)
      }
      if (!/rejected|fetch first|non-fast-forward/i.test(pushed.stderr) || attempt === PUSH_TRIES)
        return out('failed', `Live, but git push failed: ${lastWords(pushed)}`)
    } finally {
      fs.rmSync(index, { force: true })
    }
  }
  return out('failed', 'Live, but main kept moving; the commit did not land.')
}
