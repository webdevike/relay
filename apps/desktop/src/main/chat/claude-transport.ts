import * as os from 'node:os'
import { buildCommand } from '../eva/spawn'
import { OmpStdioTransport } from './omp-transport'

export interface ClaudeBridgeOptions {
  /** EVAOS_CLAUDE_BRIDGE_BIN: `.claude/bridge/session.ts` live, a `.mjs` fake in tests. */
  bridgeBin: string
  live: boolean
  /** Extra env for the next spawn only (e2e). */
  takeExtraEnv?: () => Record<string, string>
}

/**
 * Claude Code through the Eva bridge: `session.ts --rpc [--resume file] ...flags`, one JSON object
 * per line each way, the same frames as omp rpc-ui. Differs from OmpStdioTransport only in binary
 * and argv, so framing, _stderr/_eof and the never-signal close come from the same code (D-17).
 * Argv is an array through buildCommand: no shell.
 */
export class ClaudeBridgeTransport extends OmpStdioTransport {
  constructor(o: ClaudeBridgeOptions) {
    super({
      ompBin: o.bridgeBin,
      live: o.live,
      takeExtraEnv: o.takeExtraEnv,
      kind: 'claude',
      command: ({ spawnPath, sessionFile, args, env }) => {
        const bridgeArgs = ['--rpc', ...(sessionFile ? ['--resume', sessionFile] : []), ...args]
        const c = buildCommand(o.bridgeBin, bridgeArgs, {
          pathEnv: spawnPath,
          homedir: os.homedir(),
          execPath: process.execPath,
          baseEnv: env,
        })
        return { ...c, visibleArgs: bridgeArgs }
      },
    })
  }
}
