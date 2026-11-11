import * as fs from 'node:fs'
import type { CouncilHarness, CouncilModelKey, CouncilThinking } from '@relay/protocol'
import { COUNCIL_HARNESS_LABEL, COUNCIL_MODELS } from '@relay/protocol'
import { findClaude, findCodex, isExecutable, seatPath } from './bins'
import { installGuard } from './guard'
import { startClaudeSeat } from './seat-claude'
import { startCodexSeat } from './seat-codex'
import { startOmpSeat } from './seat-omp'
import type { SeatSession } from './state'

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
  /** The seat's scratch dir inside the room (its TMPDIR), so nothing it makes lands in /tmp. */
  scratch: string
  /** Where an omp seat keeps its session file. */
  sessionDir: string
  /** Pick this session up instead of starting a fresh one (ignored when the harness differs). */
  resume?: SeatSession
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
  /** True when `spec.resume` was picked up; false when the seat started a fresh session. */
  readonly resumed: boolean
  turn(input: SeatTurnInput): Promise<SeatTurnResult>
  /** The session to resume this seat from later; null before it has one. */
  session(): SeatSession | null
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
 * `ompModel` (tests: EVAOS_ROOMS_SEAT_MODEL) runs every seat in omp on that model instead.
 */
export function createSeatLauncher(opts: {
  ompBin: string
  claudeBin?: string
  codexBin?: string
  ompModel?: string
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
}): SeatLauncher {
  const log = opts.log ?? (() => undefined)
  const pathEnv = seatPath(opts.env?.PATH ?? process.env.PATH)
  const env: NodeJS.ProcessEnv = { ...opts.env, PATH: pathEnv }

  return {
    async start(spec) {
      fs.mkdirSync(spec.scratch, { recursive: true })
      fs.mkdirSync(spec.sessionDir, { recursive: true })
      const guard = installGuard({
        workdir: spec.workdir,
        asksDir: spec.asksDir,
        seatId: spec.seatId,
        path: pathEnv,
        scratch: spec.scratch,
      })
      const model = COUNCIL_MODELS[spec.model]
      const label = COUNCIL_HARNESS_LABEL[spec.harness]
      const ompOpts = {
        ompBin: opts.ompBin,
        guard,
        env,
        log,
        ...(opts.ompModel ? { model: opts.ompModel } : {}),
      }
      const omp = (why: string): Promise<SeatHandle> => {
        const fallback = `${why}, so ${model.short} runs in omp`
        log(`seat ${spec.seatId}: ${fallback}`)
        return startOmpSeat(spec, ompOpts, fallback)
      }
      const native = async (
        provider: 'anthropic' | 'openai',
        bin: string | null,
        run: (bin: string, spec: SeatSpec) => Promise<SeatHandle>,
      ): Promise<SeatHandle> => {
        if (model.provider !== provider) return omp(`${label} does not run ${model.short}`)
        if (bin === null || !isExecutable(bin)) return omp(`${label} is not installed`)
        try {
          return await run(bin, spec)
        } catch (e) {
          const why = (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 120)
          if (spec.resume) {
            // A session the harness no longer has: start the same seat fresh before giving up on it.
            log(`seat ${spec.seatId}: could not resume (${why}), starting fresh`)
            const { resume: _gone, ...fresh } = spec
            try {
              return await run(bin, fresh)
            } catch {
              /* falls back to omp below */
            }
          }
          return omp(`${label} did not start (${why})`)
        }
      }
      try {
        const handle =
          opts.ompModel !== undefined || spec.harness === 'omp'
            ? await startOmpSeat(spec, ompOpts)
            : spec.harness === 'claude-code'
              ? await native('anthropic', opts.claudeBin ?? findClaude(env), (claudeBin, s) =>
                  startClaudeSeat(s, { claudeBin, guard, env, log }),
                )
              : await native('openai', opts.codexBin ?? findCodex(env), (codexBin, s) =>
                  startCodexSeat(s, { codexBin, guard, env, log }),
                )
        return {
          harness: handle.harness,
          ...(handle.fallback ? { fallback: handle.fallback } : {}),
          resumed: handle.resumed,
          turn: (input) => handle.turn(input),
          session: () => handle.session(),
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
