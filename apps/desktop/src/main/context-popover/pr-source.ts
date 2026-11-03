// Pull request facts from gh, shared by the context popover and the Artifacts status reader: one
// BackgroundCache, so a PR both show is fetched once. Reads never wait; a refresh that changes a
// value tells every listener.
import * as os from 'node:os'
import type { MainContext } from '../context'
import { buildCommand, childPathFor, runCapture } from '../eva/spawn'
import { BackgroundCache } from './bg-cache'
import { fetchPr, type PrFacts } from './gh'

/** gh and git never run longer than this. */
const RUN_TIMEOUT_MS = 20_000

/** Runs `bin` in `cwd` with the app's PATH, no prompts and no git locks. */
export type ToolRun = (
  bin: string,
  args: string[],
  cwd: string,
) => Promise<{ code: number | null; stdout: string }>

export function toolRunner(ctx: MainContext): ToolRun {
  const home = os.homedir()
  let pathEnv: Promise<string> | null = null
  return async (bin, args, cwd) => {
    pathEnv ??= childPathFor(ctx.env.live, home)
    const cmd = buildCommand(bin, args, {
      pathEnv: await pathEnv,
      homedir: home,
      execPath: process.execPath,
      baseEnv: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_OPTIONAL_LOCKS: '0' },
    })
    return runCapture(cmd, cwd, RUN_TIMEOUT_MS)
  }
}

export interface PrSource {
  /** Fixture data (dev, e2e) names real PRs; only live data reaches GitHub. */
  readonly allowed: boolean
  /** The PR's facts as last fetched (null before, or when gh is not allowed); queues a refresh when old. */
  get(repo: string, number: number, hot: boolean): PrFacts | null
  /** Called after a refresh changed a PR's facts. */
  onChange(cb: () => void): () => void
}

export function createPrSource(ctx: MainContext, run: ToolRun): PrSource {
  const listeners = new Set<() => void>()
  const allowed = ctx.env.live && !ctx.env.e2e
  const prs = new BackgroundCache<PrFacts>({
    onChange: () => {
      for (const cb of [...listeners]) cb()
    },
    hotMs: 30_000,
    coldMs: 5 * 60_000,
    backoffMs: 2 * 60_000,
  })
  return {
    allowed,
    get: (repo, number, hot) =>
      allowed
        ? prs.get(`${repo}#${number}`, hot, () =>
            fetchPr((args) => run('gh', args, ctx.env.evaRoot), repo, number),
          )
        : null,
    onChange: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
