import { app } from 'electron'
import { setTimeout as delay } from 'node:timers/promises'
import { homedir, tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { BENCH_LIMITS, BenchIdentity, BenchStartSchema, type BenchRun } from '@evaos/contract'
import { createTestBench, type TestBench } from './engine'
import { createBenchAdjudicator } from './models'
import { resolveEnv } from '../env'
import { childPathFor } from '../eva/spawn'

export function benchmarkExit(run: BenchRun): number {
  if (
    run.errors.some((error) => error.code !== 'cancelled') ||
    ['error', 'interrupted', 'running'].includes(run.status)
  )
    return 2
  if (run.status === 'cancelled') return 130
  return run.scores
    .filter((score) => score.split === 'all')
    .some((score) => score.inspect !== 'qualified')
    ? 1
    : 0
}
export function parseCli(args: readonly string[]) {
  const [command, ...rest] = args
  if (!['models', 'run', 'list', 'show'].includes(command ?? ''))
    throw new Error('Use models, run, list or show <id>')
  const configurations: Array<{ provider: string; model: string; profile: string }> = []
  const limits = { ...BENCH_LIMITS }
  let profile = 'current',
    id: string | undefined
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i],
      value = rest[i + 1]
    if (command === 'show' && i === 0 && !flag?.startsWith('--')) {
      id = flag
      continue
    }
    if (!value) throw new Error('Missing CLI option value')
    if (flag === '--profile' && ['current', 'personal', 'work'].includes(value)) profile = value
    else if (flag === '--model' && command === 'run') {
      const slash = value.indexOf('/')
      if (slash < 1) throw new Error('Model must be provider/model')
      const provider = value.slice(0, slash)
      configurations.push(
        BenchIdentity.parse({
          provider,
          model: value.slice(slash + 1),
          profile: provider === 'jev' ? 'current' : profile,
        }),
      )
    } else if (flag === '--judgment-ms' && command === 'run') limits.judgmentMs = Number(value)
    else if (flag === '--total-ms' && command === 'run') limits.totalMs = Number(value)
    else throw new Error('Unknown CLI option')
    i++
  }
  if (command === 'show' && !id) throw new Error('show requires a run ID')
  if (command !== 'models' && command !== 'run' && rest.length !== (command === 'show' ? 1 : 0))
    throw new Error('Unexpected CLI arguments')
  return {
    command: command!,
    profile,
    id,
    input: command === 'run' ? BenchStartSchema.parse({ configurations, limits }) : null,
  }
}
export async function runCli(
  args: readonly string[],
  bench: TestBench,
  io: { out: (value: unknown) => void; progress: (value: unknown) => void },
  signal: AbortSignal,
): Promise<number> {
  let unsubscribe = (): void => undefined
  try {
    const parsed = parseCli(args)
    if (parsed.command === 'models') io.out(await bench.models(signal))
    else if (parsed.command === 'list') io.out(bench.list())
    else if (parsed.command === 'show') io.out(bench.get(parsed.id!))
    else {
      signal.throwIfAborted()
      unsubscribe = bench.subscribe(io.progress)
      const { runId } = bench.start(parsed.input!)
      const cancel = (): void => {
        bench.cancel(runId)
      }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        for (;;) {
          const run = bench.get(runId)
          if (run.status !== 'running') {
            io.out(run)
            return benchmarkExit(run)
          }
          if (signal.aborted) cancel()
          await delay(100)
        }
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    }
    return 0
  } catch {
    io.out({
      error: signal.aborted
        ? 'Test Bench cancelled'
        : 'Test Bench command failed: invalid input, unavailable provider or unreadable stored result',
    })
    return signal.aborted ? 130 : 2
  } finally {
    unsubscribe()
    await bench.dispose()
  }
}

async function main(): Promise<void> {
  app.setActivationPolicy?.('accessory')
  app.on('window-all-closed', () => {
    /* Fixture windows are short-lived; the CLI owns exit. */
  })
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  const control = createInterface({ input: process.stdin })
  control.on('line', (line) => {
    if (line === 'cancel') abort()
  })
  process.on('SIGINT', abort)
  process.on('SIGTERM', abort)
  let code = 2
  try {
    const parsed = parseCli(process.argv.slice(2))
    const env = resolveEnv({
      env: process.env,
      isPackaged: app.isPackaged,
      repoRoot: resolve(__dirname, '../../../..'),
      homedir: homedir(),
      tmpdir: tmpdir(),
      pid: process.pid,
    })
    if (!process.env.EVAOS_CONFIG_DIR) throw new Error('CLI requires stable EVAOS_CONFIG_DIR')
    app.setPath('userData', resolve(env.configDir, 'test-bench', 'electron'))
    await app.whenReady()
    const adjudicator = createBenchAdjudicator({
      evaRoot: env.evaRoot,
      ompBin: env.ompBin,
      profiles: [parsed.profile],
      build: {
        pathEnv: await childPathFor(env.live, homedir()),
        homedir: homedir(),
        execPath: process.execPath,
        baseEnv: process.env,
      },
    })
    const bench = createTestBench({ configDir: env.configDir, adjudicator })
    code = await runCli(
      process.argv.slice(2),
      bench,
      {
        out: (value) => process.stdout.write(JSON.stringify(value) + '\n'),
        progress: (value) => process.stderr.write(JSON.stringify(value) + '\n'),
      },
      controller.signal,
    )
  } catch {
    process.stdout.write(
      JSON.stringify({ error: 'Test Bench startup failed; check command and EVAOS_CONFIG_DIR' }) +
        '\n',
    )
  } finally {
    control.close()
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
    // Electron exits immediately: drain piped JSON/progress before ending the process.
    await Promise.all(
      [process.stdout, process.stderr].map(
        (stream) =>
          new Promise<void>((resolve, reject) => {
            stream.write('', (error) => (error ? reject(error) : resolve()))
          }),
      ),
    ).catch(() => {
      code = 2
    })
    app.exit(code)
  }
}

if (process.versions.electron && /(?:^|[/\\])test-bench\.js$/.test(process.argv[1] ?? ''))
  void main()
