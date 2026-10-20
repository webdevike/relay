import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MainContext } from '../context'
import { testBenchInvoke, type BenchProgress } from '@evaos/contract'
type Handler = (event: unknown, input: unknown) => Promise<unknown>
const handlers = vi.hoisted(() => new Map<string, Handler>())
vi.mock('electron', () => ({
  app: { isPackaged: true },
  ipcMain: { handle: (name: string, fn: Handler) => handlers.set(name, fn) },
}))
vi.mock('../window', () => ({ isAppUrl: (url: string) => url === 'app://shell' }))
vi.mock('./browser', () => ({ collectBrowser: vi.fn() }))
import { BenchInfrastructureError, createTestBench, type TestBench } from './engine'
import { registerTestBenchIpc } from './ipc'
const id = '11111111-1111-4111-8111-111111111111'
const foreign = '22222222-2222-4222-8222-222222222222'
let bench: TestBench
let ctx: MainContext
let quit: () => Promise<void>
let listener: (p: BenchProgress) => void
let unsubscribe: Mock
const send = vi.fn()
async function call(
  name: string,
  input: unknown,
  event: unknown = { senderFrame: { url: 'app://shell' }, sender: ctx.shell.webContents },
) {
  const result = await handlers.get(`testBench.${name}`)!(event, input)
  if (!result || typeof result !== 'object' || !('ok' in result))
    throw new Error('Invalid handler result')
  return result
}
beforeEach(() => {
  handlers.clear()
  send.mockClear()
  unsubscribe = vi.fn()
  bench = {
    models: vi.fn(async () => []),
    start: vi.fn(() => ({ runId: id })),
    cancel: vi.fn((runId) => ({ cancelled: runId === id })),
    list: vi.fn(() => []),
    get: vi.fn(),
    evidence: vi.fn(),
    subscribe: (fn) => {
      listener = fn
      return unsubscribe
    },
    dispose: vi.fn(async () => {}),
  }
  ctx = {
    bench,
    shell: { webContents: { send, isDestroyed: () => false } },
    onBeforeQuit: (fn: () => Promise<void>) => {
      quit = fn
    },
  } as unknown as MainContext
  registerTestBenchIpc(ctx)
})
describe('Test Bench IPC boundaries', () => {
  it('requires an explicitly supplied service', () => {
    expect(() => registerTestBenchIpc({ ...ctx, bench: undefined })).toThrow('service is required')
  })
  it('rejects non-shell frames and foreign webContents', async () => {
    expect(
      await call(
        'list',
        {},
        { senderFrame: { url: 'https://foreign.test' }, sender: ctx.shell.webContents },
      ),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(
      await call('list', {}, { senderFrame: { url: 'app://shell' }, sender: {} }),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(bench.list).not.toHaveBeenCalled()
  })
  it('validates IDs and start payloads before engine access', async () => {
    expect(await call('get', { runId: '../private' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    })
    expect(await call('evidence', { runId: id, evidenceId: '/etc/passwd' })).toMatchObject({
      ok: false,
    })
    expect(await call('start', { configurations: [], prompt: 'override' })).toMatchObject({
      ok: false,
    })
    expect(bench.get).not.toHaveBeenCalled()
    expect(bench.start).not.toHaveBeenCalled()
  })
  it('validates stored and model payloads even in packaged builds', async () => {
    vi.mocked(bench.models).mockResolvedValue([{ secret: 'private' }] as never)
    vi.mocked(bench.list).mockReturnValue([{ secret: 'private' }] as never)
    for (const channel of ['models', 'list']) {
      const result = await call(channel, {})
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain('private')
    }
  })
  it('preserves safe typed provider diagnostics and hides unknown errors', async () => {
    vi.mocked(bench.models).mockRejectedValue(
      new BenchInfrastructureError('provider', 'Isolation gate refused'),
    )
    expect(await call('models', {})).toMatchObject({
      ok: false,
      error: { code: 'provider', message: 'Isolation gate refused' },
    })
    vi.mocked(bench.models).mockRejectedValue(new Error('secret token'))
    expect(JSON.stringify(await call('models', {}))).not.toContain('secret token')
  })
  it('forwards progress and disposes its subscription and owned service', async () => {
    const progress: BenchProgress = {
      runId: id,
      status: 'running',
      planned: 48,
      completed: 1,
      caseId: null,
      configId: null,
    }
    listener(progress)
    expect(send).toHaveBeenCalledWith('testBench.progress', progress)
    await quit()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(bench.dispose).toHaveBeenCalledOnce()
  })
  it('forwards only the requested cancellation and evidence IDs', async () => {
    expect(await call('cancel', { runId: foreign })).toEqual({
      ok: true,
      value: { cancelled: false },
    })
    expect(bench.cancel).toHaveBeenCalledWith(foreign)
    vi.mocked(bench.evidence).mockReturnValue({ dataUrl: 'data:image/png;base64,AA==' })
    await call('evidence', { runId: id, evidenceId: foreign })
    expect(bench.evidence).toHaveBeenCalledWith(id, foreign)
  })
  it('real engine rejects foreign evidence and leaves another run active when cancellation ID differs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-ipc-'))
    const service = createTestBench({
      configDir: dir,
      adjudicator: { models: async () => [], judge: vi.fn() },
      collector: async (_f, _limits, signal) => {
        const pending = Promise.withResolvers<never>()
        signal.addEventListener('abort', () => pending.reject(new Error('cancelled')), {
          once: true,
        })
        return pending.promise
      },
    })
    try {
      registerTestBenchIpc({ ...ctx, bench: service })
      const started = await call('start', {
        configurations: [
          { provider: 'test', model: 'a', profile: 'current' },
          { provider: 'test', model: 'b', profile: 'current' },
        ],
      })
      expect(started.ok).toBe(true)
      if (!('value' in started)) throw new Error('Start failed')
      const { runId } = testBenchInvoke['testBench.start'].output.parse(started.value)
      expect(await call('cancel', { runId: foreign })).toEqual({
        ok: true,
        value: { cancelled: false },
      })
      expect(service.get(runId).status).toBe('running')
      expect(await call('evidence', { runId, evidenceId: foreign })).toMatchObject({ ok: false })
      expect(await call('cancel', { runId })).toEqual({ ok: true, value: { cancelled: true } })
    } finally {
      await service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
