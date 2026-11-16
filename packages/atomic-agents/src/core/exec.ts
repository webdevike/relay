import { Effect, type Redacted, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export interface ExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/**
 * Run a command to completion, collecting stdout and stderr separately. Stdin is closed: `omp -p`
 * otherwise waits for EOF on a piped stdin. Interruption kills the child. `env` is merged over the
 * inherited environment; a variable set to `undefined` is removed from the child's.
 */
export const exec = Effect.fnUntraced(function*(command: string, args: ReadonlyArray<string>, options: {
  readonly cwd?: string
  readonly env?: Record<string, string | Redacted.Redacted<string> | undefined>
} = {}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* Effect.scoped(Effect.gen(function*() {
    const handle = yield* spawner.spawn(ChildProcess.make(command, args, { cwd: options.cwd, env: options.env, extendEnv: true, stdin: "ignore" }))
    const [stdout, stderr, exitCode] = yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode
    ], { concurrency: "unbounded" })
    return { stdout, stderr, exitCode: Number(exitCode) } satisfies ExecResult
  }))
})
