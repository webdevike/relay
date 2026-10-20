import {
  BenchProgressSchema,
  testBenchInvoke,
  type InvokeChannel,
  type InvokeInput,
  type InvokeOutput,
} from '@evaos/contract'
import type { MainContext } from '../context'
import { handle, emit } from '../ipc/handle'
import { BenchInfrastructureError } from './engine'

export function registerTestBenchIpc(ctx: MainContext): void {
  const bench = ctx.bench
  if (!bench) throw new Error('Test Bench service is required')
  function bind<K extends keyof typeof testBenchInvoke & InvokeChannel>(
    channel: K,
    operation: (input: InvokeInput<K>) => InvokeOutput<K> | Promise<InvokeOutput<K>>,
  ): void {
    handle(ctx, channel, async (input, event) => {
      if (event.sender !== ctx.shell.webContents)
        throw Object.assign(new Error('Caller is not the app shell'), { code: 'forbidden' })
      try {
        const value = await operation(input)
        return testBenchInvoke[channel].output.parse(value) as InvokeOutput<K>
      } catch (error) {
        if (error instanceof BenchInfrastructureError) throw error
        throw Object.assign(
          new Error('Test Bench operation failed. Check the saved run or retry.'),
          { code: 'test-bench-error' },
        )
      }
    })
  }
  bind('testBench.models', () => bench.models())
  bind('testBench.start', (input) => bench.start(input))
  bind('testBench.cancel', ({ runId }) => bench.cancel(runId))
  bind('testBench.list', () => bench.list())
  bind('testBench.get', ({ runId }) => bench.get(runId))
  bind('testBench.evidence', ({ runId, evidenceId }) => bench.evidence(runId, evidenceId))
  const unsubscribe = bench.subscribe((progress) =>
    emit(ctx, 'testBench.progress', BenchProgressSchema.parse(progress)),
  )
  ctx.onBeforeQuit(async () => {
    unsubscribe()
    await bench.dispose()
  })
}
