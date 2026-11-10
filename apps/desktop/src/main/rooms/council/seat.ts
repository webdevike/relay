import type { CouncilHarness, CouncilModelKey, CouncilThinking } from '@relay/protocol'
import { COUNCIL_HARNESS_LABEL, COUNCIL_MODELS } from '@relay/protocol'
import { findClaude, findCodex, isExecutable, seatPath } from './bins'
import { installGuard } from './guard'
import { startClaudeSeat } from './seat-claude'
import { startCodexSeat } from './seat-codex'
import { startOmpSeat } from './seat-omp'

/** One council seat to start: a model in a harness, working in its own worktree. */
export interface SeatSpec {
  roomId: string
  seatId: string
  harness: CouncilHarness
  model: CouncilModelKey
  thinking: CouncilThinking
  systemPrompt: string
  /** The seat's worktree. */
  cwd: string
  /** Refs and the room workdir: readable (and for Claude Code and Codex, added dirs). */
  readDirs: string[]
  /** Room root: the guard boundary. */
  workdir: string
  /** Where the guard writes `<askId>.json` and waits for `<askId>.answer`. */
  asksDir: string
  /** Claude Code `--max-budget-usd`. */
  budgetUsd?: number
}

export interface SeatPresence {
  state: 'thinking' | 'reading' | 'typing'
  detail?: string
}

export interface SeatTurnInput {
  prompt: string
  /** Absolute image paths to attach to this turn. */
  images?: string[]
  signal?: AbortSignal
  onPresence?(p: SeatPresence): void
  onPartial?(text: string): void
}

export interface SeatUsage {
  /** Uncached input tokens. */
  input: number
  output: number
  cached: number
}

export interface SeatTurnResult {
  text: string
  usage: SeatUsage
  /** Images the seat generated this turn, absolute paths. */
  images: string[]
  toolCalls: number
  ms: number
}

export interface SeatHandle {
  /** What actually runs, after fallback. */
  readonly harness: CouncilHarness
  /** Why it fell back to omp, shown in the room. */
  readonly fallback?: string
  turn(input: SeatTurnInput): Promise<SeatTurnResult>
  stop(): Promise<void>
  onExit(cb: (err?: Error) => void): void
}

export interface SeatLauncher {
  start(spec: SeatSpec): Promise<SeatHandle>
}

/**
 * Starts seats in their harness, each under its own outward-action guard. A Claude Code or
 * Codex seat whose binary is missing, cannot run the model's provider, or fails to start runs
 * the same model in omp instead, and `handle.fallback` says why in one line.
 */
export function createSeatLauncher(opts: {
  ompBin: string
  claudeBin?: string
  codexBin?: string
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
}): SeatLauncher {
  const log = opts.log ?? (() => undefined)
  const pathEnv = seatPath(opts.env?.PATH ?? process.env.PATH)
  const env: NodeJS.ProcessEnv = { ...opts.env, PATH: pathEnv }

  return {
    async start(spec) {
      const guard = installGuard({
        workdir: spec.workdir,
        asksDir: spec.asksDir,
        seatId: spec.seatId,
        path: pathEnv,
      })
      const model = COUNCIL_MODELS[spec.model]
      const label = COUNCIL_HARNESS_LABEL[spec.harness]
      const omp = (why: string): Promise<SeatHandle> => {
        const fallback = `${why}, so ${model.short} runs in omp`
        log(`seat ${spec.seatId}: ${fallback}`)
        return startOmpSeat(spec, { ompBin: opts.ompBin, guard, env, log }, fallback)
      }
      const native = async (
        provider: 'anthropic' | 'openai',
        bin: string | null,
        run: (bin: string) => Promise<SeatHandle>,
      ): Promise<SeatHandle> => {
        if (model.provider !== provider) return omp(`${label} does not run ${model.short}`)
        if (bin === null || !isExecutable(bin)) return omp(`${label} is not installed`)
        try {
          return await run(bin)
        } catch (e) {
          const why = (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 120)
          return omp(`${label} did not start (${why})`)
        }
      }
      try {
        const handle =
          spec.harness === 'claude-code'
            ? await native('anthropic', opts.claudeBin ?? findClaude(env), (claudeBin) =>
                startClaudeSeat(spec, { claudeBin, guard, env, log }),
              )
            : spec.harness === 'codex'
              ? await native('openai', opts.codexBin ?? findCodex(env), (codexBin) =>
                  startCodexSeat(spec, { codexBin, guard, env, log }),
                )
              : await startOmpSeat(spec, { ompBin: opts.ompBin, guard, env, log })
        return {
          harness: handle.harness,
          ...(handle.fallback ? { fallback: handle.fallback } : {}),
          turn: (input) => handle.turn(input),
          onExit: (cb) => handle.onExit(cb),
          stop: async () => {
            try {
              await handle.stop()
            } finally {
              guard.dispose()
            }
          },
        }
      } catch (e) {
        guard.dispose()
        throw e
      }
    },
  }
}
