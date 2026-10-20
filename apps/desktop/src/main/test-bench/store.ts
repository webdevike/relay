import * as fs from 'node:fs'
import * as path from 'node:path'
import { BenchId, BenchRunSchema, BENCH_LIMITS, type BenchRun } from '@evaos/contract'
import { createConfigStore } from '../config-store'
import { hash } from './fixtures'
import { scoreRun } from './scoring'

const MAX_JSON_BYTES = 12 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
export function createBenchStore(configDir: string) {
  const root = path.resolve(configDir, 'test-bench', 'runs')
  fs.mkdirSync(root, { recursive: true })
  const base = fs.realpathSync(root)
  function directory(id: string, create = false): string {
    BenchId.parse(id)
    const target = path.join(base, id)
    if (create) fs.mkdirSync(target, { recursive: true })
    const real = fs.realpathSync(target)
    if (!real.startsWith(base + path.sep) || fs.lstatSync(target).isSymbolicLink())
      throw new Error('Run directory escapes evidence store')
    return real
  }
  function file(dir: string, name: string): string {
    const target = path.join(dir, name)
    const real = fs.realpathSync(target)
    if (!real.startsWith(dir + path.sep) || fs.lstatSync(target).isSymbolicLink())
      throw new Error('Evidence path escapes run')
    return real
  }
  function get(id: string, active = false): BenchRun {
    const dir = directory(id)
    const target = file(dir, 'run.json')
    if (fs.statSync(target).size > MAX_JSON_BYTES) throw new Error('Run JSON exceeds size limit')
    let run: BenchRun
    try {
      run = BenchRunSchema.parse(JSON.parse(createConfigStore(dir).readText('run.json')!))
    } catch {
      throw new Error(`Corrupt Test Bench run ${id}`)
    }
    if (run.id !== id) throw new Error('Run identity mismatch')
    const configs = new Set(run.configurations.map((config) => config.id))
    if (
      configs.size !== run.configurations.length ||
      new Set(run.cases.map((c) => c.id)).size !== 24
    )
      throw new Error('Corrupt duplicate identities')
    for (const config of run.configurations) {
      const { id: configId, ...content } = config
      if (
        hash(JSON.stringify(content)) !== configId ||
        hash(config.rubric.text) !== config.rubric.hash ||
        hash(config.skill.text) !== config.skill.hash
      )
        throw new Error('Corrupt configuration digest')
    }
    for (const c of run.cases) {
      if (c.evidence && hash(JSON.stringify(c.evidence.envelope)) !== c.evidence.digest)
        throw new Error('Corrupt evidence digest')
      if (
        c.judgments.length !== configs.size ||
        new Set(c.judgments.map((j) => j.configId)).size !== configs.size
      )
        throw new Error('Corrupt judgment matrix')
      for (const j of c.judgments) {
        const config = run.configurations.find((config) => config.id === j.configId)
        if (
          !config ||
          (j.status === 'valid') !== (j.answer !== null) ||
          (j.status === 'error') !== (j.error !== null)
        )
          throw new Error('Corrupt judgment state')
        if (j.answer && Buffer.byteLength(j.answer.raw) > config.limits.rawBytes)
          throw new Error('Corrupt oversized answer')
      }
      if (
        c.evidence &&
        Buffer.byteLength(JSON.stringify(c.evidence.envelope)) >
          run.configurations[0]!.limits.envelopeBytes
      )
        throw new Error('Corrupt oversized envelope')
    }
    if (run.status === 'running' && !active) {
      run.status = 'interrupted'
      run.errors.push({
        code: 'interrupted',
        message: 'Previous process stopped before terminal checkpoint',
        caseId: null,
        configId: null,
      })
      for (const c of run.cases)
        for (const j of c.judgments)
          if (j.status === 'started') {
            j.status = 'error'
            j.error = {
              code: 'interrupted',
              message: 'Judgment interrupted',
              caseId: c.id,
              configId: j.configId,
            }
          }
    }
    if (
      run.status === 'completed' &&
      (run.errors.length ||
        run.cases.some(
          (c) => c.error || !c.evidence || c.judgments.some((j) => j.status !== 'valid'),
        ))
    ) {
      throw new Error('Corrupt completed run has missing or failed work')
    }
    run.scores = scoreRun(run)
    return run
  }
  return {
    get,
    save(run: BenchRun): void {
      const parsed = BenchRunSchema.parse(run)
      if (Buffer.byteLength(JSON.stringify(parsed)) > MAX_JSON_BYTES)
        throw new Error('Run JSON exceeds size limit')
      const dir = directory(run.id, true)
      if (fs.existsSync(path.join(dir, 'run.json'))) file(dir, 'run.json')
      const temp = path.join(dir, `.run.json.${process.pid}.tmp`)
      if (fs.existsSync(temp)) throw new Error('Unexpected checkpoint temporary file')
      createConfigStore(dir).writeJson('run.json', parsed)
    },
    png(runId: string, id: string, bytes: Buffer, maximum = BENCH_LIMITS.pngBytes): void {
      BenchId.parse(id)
      if (
        bytes.length > maximum ||
        bytes.length < 24 ||
        !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
      )
        throw new Error('Invalid or oversized PNG')
      const dir = directory(runId)
      fs.writeFileSync(path.join(dir, `${id}.png`), bytes, { flag: 'wx', mode: 0o600 })
    },
    evidence(runId: string, id: string): { dataUrl: string } {
      BenchId.parse(id)
      const run = get(runId, true)
      const proof = run.cases
        .flatMap((c) => (c.evidence ? [c.evidence] : []))
        .find((e) => e.beforeId === id || e.afterId === id)
      if (!proof) throw new Error('Evidence is not referenced by this run')
      const target = file(directory(runId), `${id}.png`)
      const stat = fs.statSync(target)
      if (!stat.isFile() || stat.size > BENCH_LIMITS.pngBytes)
        throw new Error('Invalid evidence size')
      const bytes = fs.readFileSync(target)
      if (
        !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
        hash(bytes) !== (proof.beforeId === id ? proof.beforeDigest : proof.afterDigest)
      )
        throw new Error('Corrupt evidence PNG')
      return { dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }
    },
    list(activeId?: string): BenchRun[] {
      return fs
        .readdirSync(base, { withFileTypes: true })
        .filter((entry) => BenchId.safeParse(entry.name).success)
        .map((entry) => get(entry.name, entry.name === activeId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },
  }
}
