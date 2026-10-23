// New omp chats open in herdr, ported from native herdr.rs: omp runs in its own herdr workspace, the
// shape Relay gives phone-started sessions, so it outlives this app and can be attached to there.
// The app then reads its session file and talks to it through Relay, like any session it didn't
// start.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import type { Profile } from '@evaos/chat-core/launch'
import { runCapture, type Command } from '../eva/spawn'

/** How long `herdr agent start` may wait for omp to come up. */
const START_TIMEOUT_MS = '30000'
/** How often, and how long, to ask herdr for omp's session file while it starts. */
export const SESSION_POLL_MS = 100
export const SESSION_WAIT_MS = 30_000
/** A herdr API call answers at once; this only guards a hung CLI. */
const CALL_TIMEOUT_MS = 15_000

/** The omp extensions a named profile would not discover on its own (herdr.rs). */
const INTEGRATIONS = ['herdr-omp-agent-state.ts', 'relay-bridge.ts']

export interface HerdrResult {
  code: number | null
  stdout: string
  stderr: string
}

/** The long `herdr agent start`: settles when herdr exits, which it does once omp is ready. */
export interface HerdrStart {
  exited: Promise<{ code: number | null; stderr: string }>
  kill(): void
}

/** Runs herdr; a seam so tests and e2e can stand in for it. */
export interface HerdrRunner {
  run(args: string[]): Promise<HerdrResult>
  start(args: string[]): HerdrStart
}

export interface HerdrLaunch {
  /** Where omp runs: the Eva root. */
  root: string
  /** omp's launch flags (profile, model, thinking, approval). */
  args: readonly string[]
  /** The isolated account picked for this chat; a named one needs the desktop integrations. */
  profile: Profile | null
  /** omp's agent dir (`~/.omp/agent`), where the shared config and integrations live. */
  agentDir: string
}

export interface LaunchTiming {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  waitMs?: number
  pollMs?: number
}

const ReplySchema = z.object({
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
})
const CreatedSchema = z.object({
  root_pane: z.object({ workspace_id: z.string().min(1), pane_id: z.string().min(1) }),
})
const AgentSchema = z.object({
  agent: z.object({ agent_session: z.object({ value: z.string().min(1) }) }),
})

/**
 * A herdr API command's `result`. herdr prints its reply as JSON: on stdout when it succeeds, on
 * stderr (`{"error":{"message":…}}`) when it doesn't.
 */
async function call(runner: HerdrRunner, args: string[]): Promise<unknown> {
  const out = await runner.run(args)
  const raw = (out.code === 0 ? out.stdout : out.stderr).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`herdr: ${raw.split('\n')[0] || 'no output'}`)
  }
  const reply = ReplySchema.safeParse(parsed)
  if (!reply.success) throw new Error(`herdr: ${raw.split('\n')[0]}`)
  if (reply.data.error) throw new Error(`herdr: ${reply.data.error.message}`)
  return reply.data.result
}

/** `agent start`'s argv: omp in `pane` with the chat's flags and, for a named profile, its integrations. */
export function startArgs(name: string, pane: string, l: HerdrLaunch): string[] {
  const args = ['agent', 'start', name, '--kind', 'omp', '--pane', pane]
  args.push('--timeout', START_TIMEOUT_MS, '--', ...l.args)
  if (l.profile !== null) {
    // Named profiles isolate extension discovery too. Keep the desktop transport attached without
    // sharing credentials: the app baseline config, plus the herdr and Relay integrations.
    args.push('--config', path.join(l.agentDir, 'config.yml'))
    for (const file of INTEGRATIONS) {
      const ext = path.join(l.agentDir, 'extensions', file)
      if (!fs.existsSync(ext)) throw new Error(`missing omp desktop integration: ${ext}`)
      args.push('--extension', ext)
    }
  }
  return args
}

/**
 * Starts omp in a new herdr workspace in `root` and returns the session file omp will write (it
 * appears with the first message) as soon as herdr sees omp, well before herdr calls it ready.
 */
export async function launchInHerdr(
  runner: HerdrRunner,
  l: HerdrLaunch,
  timing: LaunchTiming = {},
): Promise<string> {
  const now = timing.now ?? Date.now
  const sleep =
    timing.sleep ??
    ((ms) => {
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, ms)
      return promise
    })
  const created = CreatedSchema.safeParse(
    await call(runner, [
      'workspace',
      'create',
      '--cwd',
      l.root,
      '--label',
      path.basename(l.root) || 'Eva',
      // Lets omp's Relay bridge rename the workspace after the chat's title.
      '--env',
      'RELAY_HERDR_OWNED=1',
      '--no-focus',
    ]),
  )
  if (!created.success) throw new Error("herdr's reply was missing an id")
  const { workspace_id: workspace, pane_id: pane } = created.data.root_pane
  try {
    return await waitForSession(runner, `relay-desktop-${now()}`, pane, l, now, sleep, timing)
  } catch (e) {
    // Don't leave an empty workspace behind.
    await call(runner, ['workspace', 'close', workspace]).catch(() => undefined)
    throw e
  }
}

async function waitForSession(
  runner: HerdrRunner,
  name: string,
  pane: string,
  l: HerdrLaunch,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  timing: LaunchTiming,
): Promise<string> {
  // `agent start` returns only once herdr reads omp's screen as ready, seconds after omp has
  // joined Relay and can take a prompt; its session file is known well before that.
  const starting = runner.start(startArgs(name, pane, l))
  const seen: { exit: { code: number | null; stderr: string } | null } = { exit: null }
  void starting.exited.then((e) => {
    seen.exit = e
  })
  const began = now()
  while (now() - began < (timing.waitMs ?? SESSION_WAIT_MS)) {
    // Not found until herdr has named the pane's agent; keep asking.
    const agent = AgentSchema.safeParse(
      await call(runner, ['agent', 'get', name]).catch(() => null),
    )
    if (agent.success) return agent.data.agent.agent_session.value
    if (seen.exit !== null && seen.exit.code !== 0) {
      const stderr = seen.exit.stderr.trim()
      let said: string | undefined
      try {
        said = ReplySchema.safeParse(JSON.parse(stderr)).data?.error?.message
      } catch {
        // not JSON: herdr's own words
      }
      throw new Error(`herdr: ${said ?? stderr}`)
    }
    await sleep(timing.pollMs ?? SESSION_POLL_MS)
  }
  starting.kill()
  throw new Error('herdr started omp but never reported its session file')
}

/** herdr as a child process: `build` turns herdr's argv into the command to run. */
export function herdrRunner(build: (args: string[]) => Promise<Command>, cwd: string): HerdrRunner {
  return {
    run: async (args) => {
      const r = await runCapture(await build(args), cwd, CALL_TIMEOUT_MS)
      return { code: r.code, stdout: r.stdout, stderr: r.stderr }
    },
    start: (args) => {
      const { promise: exited, resolve } = Promise.withResolvers<{
        code: number | null
        stderr: string
      }>()
      let kill = (): void => undefined
      void build(args).then(
        (cmd) => {
          const child = spawn(cmd.file, cmd.argv, {
            cwd,
            env: cmd.env,
            stdio: ['ignore', 'ignore', 'pipe'],
            shell: false,
          })
          kill = () => void child.kill()
          let stderr = ''
          child.stderr?.on('data', (d: Buffer) => {
            stderr += d.toString()
          })
          child.once('error', (e) => resolve({ code: null, stderr: e.message }))
          child.once('exit', (code) => resolve({ code, stderr }))
        },
        (e: unknown) => resolve({ code: null, stderr: String(e) }),
      )
      return { exited, kill: () => kill() }
    },
  }
}
