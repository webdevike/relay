import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
vi.mock('./browser', () => ({ collectBrowser: vi.fn() }))
import { createTestBench, type TestBench } from './engine'
import { createBenchStore } from './store'
import { FIXTURES, hash, publicEnvelope } from './fixtures'

const dirs: string[] = []
const services: TestBench[] = []
afterEach(async () => {
  for (const s of services.splice(0)) await s.dispose()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function saved() {
  const dir = mkdtempSync(join(tmpdir(), 'bench-store-'))
  dirs.push(dir)
  const service = createTestBench({
    configDir: dir,
    adjudicator: {
      models: async () => [],
      judge: async () => {
        throw new Error('must not call')
      },
    },
    collector: async () => {
      throw new Error('test-only collector')
    },
  })
  services.push(service)
  const { runId } = service.start({
    configurations: [
      { provider: 'test', model: 'a', profile: 'current' },
      { provider: 'test', model: 'b', profile: 'current' },
    ],
  })
  // Synchronous initial checkpoint precedes deferred execution, exactly as a process interruption.
  return {
    dir,
    runId,
    store: createBenchStore(dir),
    service,
    file: join(dir, 'test-bench', 'runs', runId, 'run.json'),
  }
}
describe('atomic bounded benchmark persistence', () => {
  it('loads interrupted checkpoints without any provider call and retains unattempted work', () => {
    const { store, runId } = saved()
    const run = store.get(runId)
    expect(run.status).toBe('interrupted')
    expect(run.cases.flatMap((c) => c.judgments).every((j) => j.status === 'unattempted')).toBe(
      true,
    )
    expect(run.scores.every((s) => s.inspect === 'not-qualified')).toBe(true)
    expect(store.list()[0]!.id).toBe(runId)
  })
  it('reports malformed and schema-invalid persisted JSON instead of fallback', () => {
    const { store, runId, file } = saved()
    writeFileSync(file, '{broken')
    expect(() => store.get(runId)).toThrow('Corrupt')
    writeFileSync(file, JSON.stringify({ id: runId, status: 'completed' }))
    expect(() => store.get(runId)).toThrow('Corrupt')
    writeFileSync(file, ' '.repeat(12 * 1024 * 1024 + 1))
    expect(() => store.get(runId)).toThrow('size limit')
  })
  it('rejects traversal, escaping run/checkpoint symlinks and unreferenced evidence', () => {
    const { store, runId, file, dir } = saved()
    expect(() => store.get('../outside')).toThrow()
    expect(() => store.evidence(runId, '../outside')).toThrow()
    expect(() => store.evidence(runId, randomUUID())).toThrow('not referenced')
    const outside = join(dir, 'outside.json')
    writeFileSync(outside, readFileSync(file))
    unlinkSync(file)
    symlinkSync(outside, file)
    expect(() => store.get(runId)).toThrow('escapes')
    const alias = randomUUID()
    symlinkSync(join(dir, 'test-bench', 'runs', runId), join(dir, 'test-bench', 'runs', alias))
    expect(() => store.get(alias)).toThrow('escapes')
  })
  it('round-trips checkpointed evidence and rejects escaping PNG symlinks', () => {
    const { store, runId, dir } = saved()
    const run = store.get(runId)
    const fixture = FIXTURES[0]!
    const envelope = publicEnvelope(fixture, {
      viewport: { width: 800, height: 600 },
      label: null,
      clipping: null,
      keyboard: null,
      persistence: null,
      pageText: fixture.attack,
    })
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
    const beforeId = randomUUID(),
      afterId = randomUUID()
    store.png(runId, beforeId, png)
    store.png(runId, afterId, png)
    run.cases[0]!.evidence = {
      id: randomUUID(),
      envelope,
      digest: hash(JSON.stringify(envelope)),
      beforeId,
      afterId,
      beforeDigest: hash(png),
      afterDigest: hash(png),
      collectedAt: new Date().toISOString(),
      durationMs: 1,
    }
    store.save(run)
    expect(store.get(runId).cases[0]!.evidence).toEqual(run.cases[0]!.evidence)
    expect(store.evidence(runId, beforeId).dataUrl).toBe(
      `data:image/png;base64,${png.toString('base64')}`,
    )
    const target = join(dir, 'test-bench', 'runs', runId, `${beforeId}.png`)
    const outside = join(dir, 'outside.png')
    writeFileSync(outside, png)
    unlinkSync(target)
    symlinkSync(outside, target)
    expect(() => store.evidence(runId, beforeId)).toThrow('escapes')
  })
  it('bounds PNG writes and validates signatures', () => {
    const { store, runId } = saved()
    expect(() => store.png(runId, randomUUID(), Buffer.alloc(30))).toThrow('Invalid')
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
    expect(() => store.png(runId, randomUUID(), png, 8)).toThrow('oversized')
    const id = randomUUID()
    store.png(runId, id, png)
    expect(() => store.png(runId, id, png)).toThrow()
  })
})
