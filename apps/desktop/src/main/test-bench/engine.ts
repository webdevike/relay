import { randomUUID } from 'node:crypto'
import {
  BENCH_LIMITS,
  BenchAnswerSchema,
  BenchEnvelopeSchema,
  BenchModelSchema,
  BenchStartSchema,
  type BenchAnswer,
  type BenchConfig,
  type BenchEnvelope,
  type BenchError,
  type BenchModel,
  type BenchProgress,
  type BenchRun,
  type BenchStart,
} from '@evaos/contract'
import {
  FIXTURES,
  FIXTURE_HASH,
  FIXTURE_VERSION,
  RUBRIC,
  SKILL,
  hash,
  publicEnvelope,
} from './fixtures'
import { collectBrowser, type Collector } from './browser'
import { createBenchStore } from './store'
import { scoreRun } from './scoring'

export type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T
export interface Adjudicator {
  models(signal: AbortSignal): Promise<BenchModel[]>
  judge(
    config: Immutable<BenchConfig>,
    envelope: Immutable<BenchEnvelope>,
    signal: AbortSignal,
  ): Promise<BenchAnswer>
}
export class BenchInfrastructureError extends Error {
  constructor(
    readonly code: BenchError['code'],
    message: string,
  ) {
    super(message)
    this.name = 'BenchInfrastructureError'
  }
}
export interface TestBench {
  models(signal?: AbortSignal): Promise<BenchModel[]>
  start(input: BenchStart): { runId: string }
  cancel(runId: string): { cancelled: boolean }
  list(): BenchRun[]
  get(runId: string): BenchRun
  evidence(runId: string, evidenceId: string): { dataUrl: string }
  subscribe(listener: (progress: BenchProgress) => void): () => void
  dispose(): Promise<void>
}
function freeze<T extends object>(value: T): Immutable<T> {
  Object.freeze(value)
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child)
  return value as Immutable<T>
}
export function configuration(
  identity: BenchStart['configurations'][number],
  limits = BENCH_LIMITS,
): BenchConfig {
  const content = {
    provider: identity.provider,
    model: identity.model,
    profile: identity.profile,
    track: 'text-observation' as const,
    rubric: { ...RUBRIC, hash: hash(RUBRIC.text) },
    skill: { ...SKILL, hash: hash(SKILL.text) },
    limits: { ...limits },
  }
  return { ...content, id: hash(JSON.stringify(content)) }
}
async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  ms: number,
): Promise<T> {
  parent.throwIfAborted()
  const controller = new AbortController()
  const gate = Promise.withResolvers<never>()
  const abort = (): void => {
    controller.abort()
    gate.reject(new BenchInfrastructureError('cancelled', 'Operation cancelled'))
  }
  const timer = setTimeout(() => {
    controller.abort()
    gate.reject(new BenchInfrastructureError('timeout', 'Operation deadline exceeded'))
  }, ms)
  parent.addEventListener('abort', abort, { once: true })
  try {
    return await Promise.race([operation(controller.signal), gate.promise])
  } finally {
    clearTimeout(timer)
    parent.removeEventListener('abort', abort)
  }
}
export function createTestBench(options: {
  configDir: string
  adjudicator: Adjudicator
  collector?: Collector
}): TestBench {
  if (!options.adjudicator) throw new Error('Test Bench requires an adjudicator')
  const store = createBenchStore(options.configDir)
  const collect = options.collector ?? collectBrowser
  const listeners = new Set<(progress: BenchProgress) => void>()
  let active: { run: BenchRun; controller: AbortController; done: Promise<void> } | undefined
  let disposed = false
  const catalogController = new AbortController()
  function checkpoint(
    run: BenchRun,
    caseId: string | null = null,
    configId: string | null = null,
  ): void {
    run.scores = scoreRun(run)
    store.save(run)
    const progress: BenchProgress = {
      runId: run.id,
      status: run.status,
      planned: run.cases.length * run.configurations.length,
      completed: run.cases
        .flatMap((c) => c.judgments)
        .filter((j) => j.status === 'valid' || j.status === 'error').length,
      caseId,
      configId,
    }
    for (const listener of listeners) {
      try {
        listener(progress)
      } catch {
        /* Consumers cannot interrupt checkpointing. */
      }
    }
  }
  async function execute(run: BenchRun, controller: AbortController): Promise<void> {
    const limits = run.configurations[0]!.limits
    let totalExpired = false
    const timer = setTimeout(() => {
      totalExpired = true
      controller.abort()
    }, limits.totalMs)
    try {
      for (const c of run.cases) {
        controller.signal.throwIfAborted()
        const fixture = FIXTURES.find((f) => f.id === c.id)!
        const began = Date.now()
        try {
          const captured = await bounded(
            (signal) => collect(fixture, limits, signal),
            controller.signal,
            limits.captureMs,
          )
          const envelope = BenchEnvelopeSchema.parse(publicEnvelope(fixture, captured.observations))
          const serialized = JSON.stringify(envelope)
          if (Buffer.byteLength(serialized) > limits.envelopeBytes)
            throw new BenchInfrastructureError('limit', 'Public envelope exceeds limit')
          const beforeId = randomUUID(),
            afterId = randomUUID()
          store.png(run.id, beforeId, captured.before, limits.pngBytes)
          store.png(run.id, afterId, captured.after, limits.pngBytes)
          c.evidence = {
            id: randomUUID(),
            envelope,
            digest: hash(serialized),
            beforeId,
            afterId,
            beforeDigest: hash(captured.before),
            afterDigest: hash(captured.after),
            collectedAt: new Date().toISOString(),
            durationMs: Date.now() - began,
          }
          checkpoint(run, c.id)
        } catch (error) {
          c.error = {
            code: error instanceof BenchInfrastructureError ? error.code : 'collector',
            message:
              error instanceof BenchInfrastructureError
                ? error.message
                : 'Browser evidence collection failed; no model decision was inferred',
            caseId: c.id,
            configId: null,
          }
          run.errors.push(c.error)
          checkpoint(run, c.id)
          if (controller.signal.aborted) throw error
          continue
        }
        const envelope = freeze(c.evidence!.envelope)
        for (const config of run.configurations) {
          controller.signal.throwIfAborted()
          const judgment = c.judgments.find((j) => j.configId === config.id)!
          judgment.status = 'started'
          judgment.startedAt = new Date().toISOString()
          checkpoint(run, c.id, config.id)
          const started = Date.now()
          try {
            const answer = BenchAnswerSchema.parse(
              await bounded(
                (signal) => options.adjudicator.judge(freeze(config), envelope, signal),
                controller.signal,
                limits.judgmentMs,
              ),
            )
            if (Buffer.byteLength(answer.raw) > limits.rawBytes)
              throw new BenchInfrastructureError('limit', 'Raw answer exceeds limit')
            for (const identity of [answer.requested, answer.returned]) {
              if (
                identity &&
                (identity.provider !== config.provider ||
                  identity.model !== config.model ||
                  identity.profile !== config.profile)
              )
                throw new BenchInfrastructureError('invalid-answer', 'Model identity mismatch')
            }
            judgment.answer = answer
            judgment.status = 'valid'
          } catch (error) {
            judgment.status = 'error'
            judgment.error = {
              code: error instanceof BenchInfrastructureError ? error.code : 'provider',
              message:
                error instanceof BenchInfrastructureError
                  ? error.message
                  : 'Adjudication failed; no valid decision recorded',
              caseId: c.id,
              configId: config.id,
            }
            run.errors.push(judgment.error)
          }
          judgment.durationMs = Date.now() - started
          checkpoint(run, c.id, config.id)
        }
      }
      controller.signal.throwIfAborted()
      run.status = run.errors.length ? 'error' : 'completed'
    } catch {
      run.status = controller.signal.aborted ? (totalExpired ? 'error' : 'cancelled') : 'error'
      run.errors.push({
        code: totalExpired ? 'timeout' : controller.signal.aborted ? 'cancelled' : 'storage',
        message: totalExpired
          ? 'Comparison deadline exceeded'
          : controller.signal.aborted
            ? 'Comparison cancelled'
            : 'Comparison could not checkpoint',
        caseId: null,
        configId: null,
      })
    } finally {
      clearTimeout(timer)
      run.finishedAt = new Date().toISOString()
      try {
        checkpoint(run)
      } finally {
        active = undefined
      }
    }
  }
  return {
    async models(signal) {
      if (disposed) throw new Error('Test Bench disposed')
      const combined = signal
        ? AbortSignal.any([signal, catalogController.signal])
        : catalogController.signal
      return (await bounded((s) => options.adjudicator.models(s), combined, 60_000)).map((model) =>
        BenchModelSchema.parse(model),
      )
    },
    start(input) {
      if (disposed || active)
        throw new Error(disposed ? 'Test Bench disposed' : 'A comparison is already active')
      const parsed = BenchStartSchema.parse(input)
      const configs = parsed.configurations.map((identity) =>
        configuration(identity, parsed.limits ?? BENCH_LIMITS),
      )
      if (new Set(configs.map((c) => c.id)).size !== configs.length)
        throw new Error('Select distinct configurations')
      const run: BenchRun = {
        version: 1,
        id: randomUUID(),
        status: 'running',
        createdAt: new Date().toISOString(),
        finishedAt: null,
        fixtureVersion: FIXTURE_VERSION,
        fixtureHash: FIXTURE_HASH,
        configurations: configs,
        errors: [],
        scores: [],
        cases: FIXTURES.map((f) => ({
          id: f.id,
          category: f.category,
          split: f.split,
          expected: f.expected,
          severity: f.severity,
          evidence: null,
          error: null,
          judgments: configs.map((c) => ({
            configId: c.id,
            status: 'unattempted',
            startedAt: null,
            durationMs: null,
            answer: null,
            error: null,
          })),
        })),
      }
      checkpoint(run)
      const controller = new AbortController()
      const done = Promise.resolve()
        .then(() => execute(run, controller))
        .catch(() => {
          /* Failed storage remains visible through the interrupted checkpoint. */
        })
      active = { run, controller, done }
      return { runId: run.id }
    },
    cancel(runId) {
      const cancelled = active?.run.id === runId
      if (cancelled) active!.controller.abort()
      return { cancelled }
    },
    list() {
      return store.list(active?.run.id)
    },
    get(runId) {
      return store.get(runId, active?.run.id === runId)
    },
    evidence(runId, evidenceId) {
      return store.evidence(runId, evidenceId)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async dispose() {
      disposed = true
      catalogController.abort()
      active?.controller.abort()
      await active?.done
      listeners.clear()
    },
  }
}
