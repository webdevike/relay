import * as os from 'node:os'
import type { Assistant, ExperimentRow } from '@evaos/contract'
import { listJobs } from '@evaos/eva-core/model/jobs-read'
import type { ChatHandles } from '../chat'
import type { MainContext } from '../context'
import { buildCommand, childPathFor, runCapture } from '../eva/spawn'
import { clockFor } from '../eva/runtime'
import { relayConfigDir } from '../relay/device'
import type { ExperimentsService } from '../experiments/experiments-service'
import { emit, handle } from '../ipc/handle'
import type { WriteQueue } from '../write-queue'
import { BackgroundCache } from './bg-cache'
import { fetchPr, type PrFacts } from './gh'
import { readGit, type GitFacts } from './git'
import { ItemReader } from './items'
import { PinStore } from './pins'
import { hostThreadFile, LineCache } from './sessions'
import { buildSnapshot } from './snapshot'

/** gh and git never run longer than this. */
const RUN_TIMEOUT_MS = 20_000
/** Test Bench folders are listed at most this often. */
const EXPERIMENTS_TTL_MS = 5_000
/** File-change bursts become one `context.changed`. */
const CHANGED_DEBOUNCE_MS = 400

/**
 * `context.get` (the popover's snapshot), `context.pin` / `context.unpin`, and `context.changed`
 * whenever a background gh or git read, a pin, or a session file changes what it would show.
 */
export function registerContext(
  ctx: MainContext,
  queue: WriteQueue,
  chat: Pick<ChatHandles, 'placeOf' | 'onSessionsChanged' | 'assistants' | 'relaySessions'>,
  experiments: ExperimentsService,
): void {
  const home = os.homedir()
  const clock = clockFor(ctx)
  let timer: NodeJS.Timeout | undefined
  const changed = (): void => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      emit(ctx, 'context.changed', {})
    }, CHANGED_DEBOUNCE_MS)
  }

  let pathEnv: Promise<string> | null = null
  const run = async (bin: string, args: string[], cwd: string) => {
    pathEnv ??= childPathFor(ctx.env.live, home)
    const cmd = buildCommand(bin, args, {
      pathEnv: await pathEnv,
      homedir: home,
      execPath: process.execPath,
      baseEnv: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_OPTIONAL_LOCKS: '0' },
    })
    return runCapture(cmd, cwd, RUN_TIMEOUT_MS)
  }
  // Fixture data (dev, e2e) names real PRs and threads; only live data reaches GitHub and the host.
  const ghAllowed = ctx.env.live && !ctx.env.e2e
  const hostDir = ghAllowed ? (ctx.env.relayDir ?? relayConfigDir(process.env, home)) : null
  const prs = new BackgroundCache<PrFacts>({
    onChange: changed,
    hotMs: 30_000,
    coldMs: 5 * 60_000,
    backoffMs: 2 * 60_000,
  })
  const gits = new BackgroundCache<GitFacts>({
    onChange: changed,
    hotMs: 5_000,
    coldMs: 60_000,
    backoffMs: 60_000,
  })
  const items = new ItemReader(ctx.env.evaRoot)
  const pins = new PinStore(ctx.config, queue)
  const lines = new LineCache()
  let benchRows: { at: number; rows: Promise<ExperimentRow[]> } | null = null

  handle(ctx, 'context.get', (q) =>
    buildSnapshot(
      {
        evaRoot: ctx.env.evaRoot,
        now: () => clock.now().getTime(),
        items: () => items.all(),
        lines,
        pins: () => pins.list(),
        placeOf: (file) => {
          try {
            return chat.placeOf(file)
          } catch {
            return null
          }
        },
        // Without a Relay link (Relay Dev) the host's own record still names each thread.
        assistants: (): Assistant[] =>
          chat
            .assistants()
            .agents.map((a) =>
              a.file !== null || hostDir === null
                ? a
                : { ...a, file: hostThreadFile(hostDir, a.id) },
            ),
        relaySessions: () => chat.relaySessions(),
        pr: (repo, number, hot) =>
          ghAllowed
            ? prs.get(`${repo}#${number}`, hot, () =>
                fetchPr((args) => run('gh', args, ctx.env.evaRoot), repo, number),
              )
            : null,
        git: (dir, base, hot) =>
          gits.get(`${dir}\n${base ?? ''}`, hot, () =>
            readGit((args, cwd) => run('git', args, cwd), dir, base),
          ),
        jobs: () => listJobs(ctx.env.evaRoot, clock.now().getTime()),
        experiments: () => {
          const now = Date.now()
          if (benchRows === null || now - benchRows.at > EXPERIMENTS_TTL_MS) {
            benchRows = { at: now, rows: experiments.list().catch(() => []) }
          }
          return benchRows.rows
        },
      },
      q,
    ),
  )
  handle(ctx, 'context.pin', async ({ ref }) => {
    const out = await pins.pin(ref)
    changed()
    return { pins: out }
  })
  handle(ctx, 'context.unpin', async ({ id }) => {
    const out = await pins.unpin(id)
    changed()
    return { pins: out }
  })
  // Subagents start and finish, assistants write their notes: a session file changed.
  const offSessions = chat.onSessionsChanged(changed)
  ctx.onBeforeQuit(async () => {
    offSessions()
    clearTimeout(timer)
  })
}
