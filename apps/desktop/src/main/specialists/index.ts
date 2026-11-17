// The Agents page (and each chat's specialist strip) from the atomic-agents service, through its
// installed CLI (`<home>/app/atomic-agents/src/cli.ts`, JSON on the last stdout line): the agents
// it loads (`list --json`), the runs with who asked (`runs`), one run (`result <run>`), and each
// agent's own files as a Files root in the installed copy. A save there is live at once (the
// service hot-reloads) and is committed back to the repo (`publish.ts`). Always this Mac's service:
// a thin client without one shows the page empty.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  AGENT_RUNS_LIMIT,
  SPECIALIST_LIMIT,
  type SpecialistAgents,
  type SpecialistRuns,
} from '@evaos/contract'
import type { ChatHandles } from '../chat'
import type { MainContext } from '../context'
import { sessionTitle } from '../context-popover/sessions'
import { buildCommand, childPathFor, runCapture, type CaptureResult } from '../eva/spawn'
import type { FilesIpc } from '../files/files-ipc'
import { emit, handle } from '../ipc/handle'
import { publishSave, readInstallSource, type GitResult, type PublishDeps } from './publish'
import { agentFolderOf, rosterOf, type AgentSource } from './roster'
import { callerOf, lastLine, specialistRunsOf } from './runs'
import { TrialRuns } from './trial-runs'

/** The week the per-specialist counts cover. */
export const SPECIALIST_DAYS = 7
const CLI_TIMEOUT_MS = 20_000
const VALIDATE_TIMEOUT_MS = 30_000
const GIT_TIMEOUT_MS = 60_000
/** How often the journal's size and time are read, and how long a burst of appends settles. */
const JOURNAL_POLL_MS = 1000
const CHANGED_DEBOUNCE_MS = 250

/** Why a CLI answer could not be read: the timeout, else its last words. */
const failure = (out: CaptureResult): string =>
  (out.timedOut
    ? 'atomic-agents took too long to answer'
    : (out.stderr || out.stdout).trim().split('\n').slice(-2).join(' ') ||
      `atomic-agents exited ${String(out.code)}`
  ).slice(0, 2000)

function git(
  gitDir: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<GitResult> {
  const { promise, resolve } = Promise.withResolvers<GitResult>()
  const child = spawn('git', args, {
    env: { ...env, GIT_DIR: gitDir, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  const timer = setTimeout(() => child.kill('SIGKILL'), GIT_TIMEOUT_MS)
  child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
  child.on('error', (e) => {
    clearTimeout(timer)
    resolve({ code: null, stdout, stderr: e.message })
  })
  child.on('close', (code) => {
    clearTimeout(timer)
    resolve({ code, stdout, stderr })
  })
  child.stdin.end(input ?? '')
  return promise
}

export function registerSpecialists(
  ctx: MainContext,
  chat: Pick<ChatHandles, 'assistants'>,
  files: Pick<FilesIpc, 'adopt'>,
): void {
  const home = ctx.env.atomicAgentsHome
  const cli = home === null ? null : path.join(home, 'app/atomic-agents/src/cli.ts')
  const homedir = os.homedir()
  let pathEnv: Promise<string> | null = null
  const childEnv = async (): Promise<NodeJS.ProcessEnv> => {
    pathEnv ??= childPathFor(ctx.env.live, homedir)
    return { ...process.env, PATH: await pathEnv }
  }
  const runCli = async (args: string[], timeoutMs = CLI_TIMEOUT_MS) => {
    if (home === null || cli === null || !fs.existsSync(cli)) return null
    pathEnv ??= childPathFor(ctx.env.live, homedir)
    const cmd = buildCommand(cli, args, {
      pathEnv: await pathEnv,
      homedir,
      execPath: process.execPath,
      baseEnv: { ...process.env, ATOMIC_AGENTS_HOME: home },
    })
    return runCapture(cmd, home, timeoutMs)
  }
  // A chat's title is read from its file once.
  const titles = new Map<string, string | null>()
  const title = (file: string): string | null => {
    if (!titles.has(file)) titles.set(file, sessionTitle(file))
    return titles.get(file) ?? null
  }
  const caller = (raw: string | undefined) => callerOf(raw, chat.assistants().agents, title)

  // The journal: watched once runs or agents were first asked for, so the page and the chats see a
  // run start and end live.
  let watching = false
  let timer: NodeJS.Timeout | undefined
  const watchJournal = (): void => {
    if (watching || home === null) return
    watching = true
    const journal = path.join(home, 'events.ndjson')
    fs.watchFile(journal, { interval: JOURNAL_POLL_MS, persistent: false }, (cur, prev) => {
      if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size) return
      clearTimeout(timer)
      timer = setTimeout(() => emit(ctx, 'agents.specialistsChanged', {}), CHANGED_DEBOUNCE_MS)
    })
  }

  // Trial arms, letters and switches, folded from the journal the CLI reads.
  const trials = home === null ? null : new TrialRuns(path.join(home, 'events.ndjson'))

  const runs = async (args: string[], agent?: string): Promise<SpecialistRuns> => {
    watchJournal()
    const empty = (available: boolean, error: string | null): SpecialistRuns => ({
      available,
      error,
      days: SPECIALIST_DAYS,
      runs: [],
      agents: [],
      updatedAt: Date.now(),
    })
    const out = await runCli(['runs', '--days', String(SPECIALIST_DAYS), ...args])
    if (out === null) return empty(false, null)
    let read: SpecialistRuns
    try {
      read = specialistRunsOf(out.stdout, caller, Date.now())
    } catch {
      return empty(true, failure(out))
    }
    if (trials === null) return read
    const now = Date.now()
    const all = trials.apply(read, caller, now, SPECIALIST_DAYS)
    return agent === undefined ? all : { ...all, runs: all.runs.filter((r) => r.agent === agent) }
  }
  handle(ctx, 'agents.specialists', () => runs(['--limit', String(SPECIALIST_LIMIT)]))
  handle(ctx, 'agents.agentRuns', ({ agent }) =>
    runs(['--every', '--agent', agent, '--limit', String(AGENT_RUNS_LIMIT)], agent),
  )

  handle(ctx, 'agents.specialistRun', async ({ run }) => {
    const out = await runCli(['result', run, '--wait', '0ms'])
    if (out === null)
      throw Object.assign(new Error('The atomic-agents service is not installed here'), {
        code: 'unavailable',
      })
    return { ok: out.code === 0, text: lastLine(out.stdout).slice(0, 2_000_000) }
  })

  // Where each agent's files are, from the last roster read.
  let sources = new Map<string, AgentSource>()
  const roster = async (): Promise<SpecialistAgents> => {
    watchJournal()
    const empty = (available: boolean, error: string | null): SpecialistAgents => ({
      available,
      error,
      agents: [],
      updatedAt: Date.now(),
    })
    const out = await runCli(['list', '--json'])
    if (out === null) return empty(false, null)
    try {
      const read = rosterOf(out.stdout)
      sources = new Map(read.sources.map((s) => [s.id, s]))
      return { available: true, error: null, agents: read.agents, updatedAt: Date.now() }
    } catch {
      return empty(true, failure(out))
    }
  }
  handle(ctx, 'agents.roster', roster)

  // Saves in an agent's folder, one at a time: checked, then committed back to the repo.
  const deps: PublishDeps = {
    git: async (gitDir, args, env, input) =>
      git(gitDir, args, { ...(await childEnv()), ...env }, input),
    validate: async (agentFile) => {
      const out = await runCli(['agent', 'validate', agentFile], VALIDATE_TIMEOUT_MS)
      if (out === null) return { ok: true }
      if (out.code === 0) return { ok: true }
      const fail = out.stdout
        .split('\n')
        .find((l) => l.startsWith('FAIL'))
        ?.replace(/^FAIL\s+/, '')
      return { ok: false, message: (fail ?? failure(out)).slice(0, 1500) }
    },
  }
  let queue: Promise<void> = Promise.resolve()

  handle(ctx, 'agents.agentFolder', async ({ agent }) => {
    if (home === null)
      throw Object.assign(new Error('The atomic-agents service is not installed here'), {
        code: 'unavailable',
      })
    if (!sources.has(agent)) await roster()
    const source = sources.get(agent)
    if (source === undefined)
      throw Object.assign(new Error(`The service has no agent ${agent}`), { code: 'not-found' })
    const allowed = [path.join(home, 'app/atomic-agents/domains'), path.join(home, 'agents')]
    const folder = agentFolderOf(source, allowed, (dir) => {
      try {
        return fs.readdirSync(dir)
      } catch {
        return []
      }
    })
    const install = readInstallSource(home)
    const inRepo = path.join(home, 'app/atomic-agents')
    const { root, name } = await files.adopt(folder.root, (rel, before, after) => {
      queue = queue.then(async () => {
        const agentFile = source.file ?? ''
        const saved = await publishSave(deps, home, readInstallSource(home), {
          agent,
          agentFile,
          file: path.join(path.dirname(agentFile), rel),
          rel,
          before,
          after,
        })
        emit(ctx, 'agents.agentSaved', saved)
      })
    })
    return {
      root,
      name,
      entry: folder.entry,
      only: folder.only,
      repo:
        install !== null && !path.relative(inRepo, folder.root).startsWith('..')
          ? path.basename(install.gitDir) === '.git'
            ? path.dirname(install.gitDir)
            : install.gitDir
          : null,
    }
  })
}
